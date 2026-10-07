import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { createPiRuntime, type ModelSource, type PiRuntime } from "../harness/pi";
import {
  parseClientMessage,
  PROTOCOL,
  ROOT_CONVERSATION,
  type ClientMessage,
  type ServerMessage
} from "../shared/protocol";
import { coreTools } from "../tools";
import { extractHosts } from "../tools/hosts";
import { Policy } from "../tools/policy";
import type { ToolSpec } from "../tools/spec";
import { dateSection, PERSONA } from "./persona";
import { AppStore, type StoreChange } from "./store";
import { Watches } from "./watches";

/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;
/** Close code for a connection to a conversation this agent does not have. */
const UNKNOWN_CONVERSATION = 4404;
/** app_meta key: the model last applied to the conversation, as `provider/id`. */
const APPLIED_MODEL = "model";

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // The socket closed between the check and the send.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One owner's agent: a Durable Object named by the server (`u:<userId>`).
 * Wiring only: the WebSocket protocol, Hob's own state, and Pi behind the
 * AgentRuntime port. Pi runs the loop and keeps the transcript in its pi_*
 * tables; Hob keeps memory and taint in app_* tables in the same database.
 */
export class PiAgent extends Agent<Env> {
  // The name is the owner's identity; never send it to clients.
  static override options = { sendIdentityOnConnect: false };

  readonly store = new AppStore(this.ctx.storage.sql);
  readonly policy = new Policy(this.store);
  readonly pi: PiRuntime = createPiRuntime({
    model: this.modelSource(),
    policy: this.policy,
    tools: () => this.tools(),
    sections: [
      // Static first, so the provider's prompt cache keeps it.
      { key: "persona", render: () => PERSONA, tag: false },
      { key: "today", render: () => dateSection(this.env.OWNER_TIMEZONE), tag: false },
      { key: "memory", render: () => this.store.memory.renderForPrompt() }
    ]
  });
  readonly watches = new Watches((conversation) => this.pi.events(conversation), send);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.lifecycle.use(this.pi.capability);
    this.store.onChange((change) => this.#broadcast(change));
  }

  /**
   * Where model calls go: AI Gateway over the AI binding. Tests substitute a
   * scripted model. Called from a field initializer, before a subclass's own
   * fields exist, so an override may use `this.env` and `this.ctx` only.
   */
  protected modelSource(): ModelSource {
    return {
      kind: "gateway",
      binding: this.env.AI,
      modelId: this.env.MODEL_ID,
      gatewayId: this.env.AI_GATEWAY_ID,
      metadata: () => ({ app: "hob" })
    };
  }

  /** The model's tools. None changes anything outside Hob in v0. */
  protected tools(): ToolSpec[] {
    return coreTools(this.store);
  }

  // The wire carries only Hob's protocol: no identity, state or MCP frames.
  override shouldSendProtocolMessages(): boolean {
    return false;
  }

  // Clients may not write Agent state; Hob does not use it.
  override shouldConnectionBeReadonly(): boolean {
    return true;
  }

  // Hob has no sub-agents. The edge forwards only the exact /chat path, and
  // this refuses /sub/<class>/<name> routing should anything else reach here.
  override async onBeforeSubAgent(): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  override async onStart(): Promise<void> {
    // Watches live in memory: give sockets that outlived the last isolate a new one.
    // One socket's failure must not fail the object's startup.
    for (const connection of this.getConnections()) {
      try {
        await this.watches.watch(connection, ROOT_CONVERSATION);
      } catch (error) {
        send(connection, { type: "error", message: `Couldn't reload the conversation: ${errorMessage(error)}` });
      }
    }
    // Pi keeps the model with the conversation. Checking it reads a whole
    // snapshot, so only do that when MODEL_ID changed since the last start.
    if (this.store.meta.get(APPLIED_MODEL) === this.pi.modelName) return;
    try {
      await this.pi.syncModel();
      this.store.meta.set(APPLIED_MODEL, this.pi.modelName);
    } catch (error) {
      console.error("Could not apply MODEL_ID to the conversation", error);
    }
  }

  override async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    const conversation = new URL(ctx.request.url).searchParams.get("session") ?? ROOT_CONVERSATION;
    if (conversation !== ROOT_CONVERSATION) {
      connection.close(UNKNOWN_CONVERSATION, "Unknown conversation");
      return;
    }
    send(connection, {
      type: "hello",
      protocol: PROTOCOL,
      conversation,
      tools: this.tools().map(({ name, description }) => ({ name, description })),
      model: this.pi.modelName
    });
    send(connection, { type: "memory", items: this.store.memory.list() });
    send(connection, { type: "taint", conversation, tainted: this.store.conversations.isTainted(conversation) });
    try {
      await this.watches.watch(connection, conversation);
    } catch (error) {
      send(connection, { type: "error", message: `Couldn't load the conversation: ${errorMessage(error)}` });
    }
  }

  override async onMessage(connection: Connection, raw: WSMessage): Promise<void> {
    const message = parseClientMessage(raw);
    if ("error" in message) {
      send(connection, { type: "error", message: message.error });
      return;
    }
    try {
      const result = await this.#dispatch(connection, message);
      if (message.id !== undefined) send(connection, { type: "result", id: message.id, result });
    } catch (error) {
      send(connection, {
        type: "error",
        ...(message.id === undefined ? {} : { id: message.id }),
        message: errorMessage(error)
      });
    }
  }

  override async onClose(connection: Connection): Promise<void> {
    await this.watches.unwatch(connection);
  }

  override async onError(connectionOrError: Connection | unknown, error?: unknown): Promise<void> {
    if (error === undefined) {
      console.error("agent error", connectionOrError);
      return;
    }
    console.error("connection error", error);
    await this.watches.unwatch(connectionOrError as Connection);
  }

  async #dispatch(connection: Connection, message: ClientMessage): Promise<unknown> {
    const conversation = ROOT_CONVERSATION;
    switch (message.type) {
      case "submit": {
        // Hosts the owner types are the ones a tainted conversation may still visit.
        this.store.conversations.addOwnerHosts(conversation, extractHosts(message.input));
        const receipt = await this.pi.runtime.submit(message.input, {
          conversation,
          operationId: message.operationId,
          whenBusy: message.whenBusy
        });
        console.log(JSON.stringify({ event: "submit", agent: this.name, ...receipt }));
        return receipt;
      }
      case "abort":
        return this.pi.runtime.abort({ conversation });
      case "reset":
        // A new topic: stop the current run first, so nothing from the old context keeps going.
        await this.pi.runtime.abort({ conversation });
        await this.pi.runtime.reset({ conversation, handoff: message.handoff });
        this.store.conversations.reset(conversation);
        return null;
      case "resync":
        await this.watches.watch(connection, conversation);
        return null;
      case "memory_set": {
        const result = this.store.memory.set(message.key, message.text, { source: "owner", tainted: false });
        if (!result.ok) throw new Error(result.error);
        return result.item;
      }
      case "memory_delete":
        return this.store.memory.delete(message.key);
    }
  }

  #broadcast(change: StoreChange): void {
    const message: ServerMessage =
      change.kind === "memory"
        ? { type: "memory", items: this.store.memory.list() }
        : {
            type: "taint",
            conversation: change.conversation,
            tainted: this.store.conversations.isTainted(change.conversation)
          };
    for (const connection of this.getConnections()) send(connection, message);
  }
}
