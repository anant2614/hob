import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import { createPiRuntime, type ModelSource, type PiRuntime } from "../harness/pi";
import { sendTelegramMessage, type TelegramMessage } from "../channels/telegram";
import {
  MAX_INPUT_CHARS,
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
import type { OperationResult, Receipt } from "./runtime";
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

/** How the agent paces Telegram replies. Tests shorten it. */
export type TelegramTiming = {
  /** Seconds after a message arrives before the first check for its answer. */
  readonly firstCheckSeconds: number;
  /** Seconds between later checks, and the step of the backoff after a failed send. */
  readonly recheckSeconds: number;
  /** How long one check waits for the answer before scheduling the next one. */
  readonly waitMs: number;
  /** With no answer after this long, tell the owner and stop checking. */
  readonly giveUpMs: number;
  /** Failed sends before a reply is given up. */
  readonly sendAttempts: number;
};

const TELEGRAM_TIMING: TelegramTiming = {
  firstCheckSeconds: 2,
  recheckSeconds: 5,
  waitMs: 5_000,
  giveUpMs: 20 * 60_000,
  sendAttempts: 5
};

function replyText(result: OperationResult): string {
  if (result.status === "done") return result.text ?? "";
  return `Sorry, I couldn't answer that (${result.reason ?? "unknown error"}).`;
}

/**
 * One owner's agent: a Durable Object named by the server (`u:<userId>`).
 * Wiring only: the WebSocket protocol, Fennec's own state, and Pi behind the
 * AgentRuntime port. Pi runs the loop and keeps the transcript in its pi_*
 * tables; Fennec keeps memory and taint in app_* tables in the same database.
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
      metadata: () => ({ app: "fennec" })
    };
  }

  /** The model's tools. None changes anything outside Fennec in v0. */
  protected tools(): ToolSpec[] {
    return coreTools(this.store);
  }

  /** How replies reach the Telegram Bot API. Tests substitute a recorder. */
  protected telegramFetch(): typeof fetch {
    return (input, init) => fetch(input, init);
  }

  protected telegramTiming(): TelegramTiming {
    return TELEGRAM_TIMING;
  }

  /**
   * A message from the owner on Telegram, already verified by the edge. It joins
   * the same conversation as the web app. The reply is owed in the outbox and
   * sent by a scheduled check, so it survives an eviction or a deploy.
   */
  async receiveTelegram(message: TelegramMessage): Promise<Receipt> {
    const op = `tg:${message.updateId}`;
    // The owner's own words, as on the web: sites named here may be visited while tainted.
    this.store.conversations.addOwnerHosts(ROOT_CONVERSATION, extractHosts(message.text));
    this.store.outbox.add(op, "telegram", message.chatId);
    // The update id is the operation id, so a redelivered update is not answered twice.
    const receipt = await this.pi.runtime.submit(message.text.slice(0, MAX_INPUT_CHARS), {
      conversation: ROOT_CONVERSATION,
      operationId: op
    });
    await this.schedule(this.telegramTiming().firstCheckSeconds, "deliverTelegramReply", { op }, { idempotent: true });
    console.log(JSON.stringify({ event: "telegram_submit", agent: this.name, ...receipt }));
    return receipt;
  }

  /** Scheduled: send the answer once the run has settled; otherwise check again later. */
  async deliverTelegramReply({ op }: { op: string }): Promise<void> {
    const timing = this.telegramTiming();
    const item = this.store.outbox.get(op);
    if (item === undefined || item.status !== "pending") return;

    const result = await this.#settled(op, timing.waitMs);
    let text: string;
    if (result !== undefined) {
      text = replyText(result);
    } else if (Date.now() - item.createdAt < timing.giveUpMs) {
      await this.schedule(timing.recheckSeconds, "deliverTelegramReply", { op });
      return;
    } else {
      text = "This is taking much longer than it should, so I've stopped waiting. Open the web app to see where it got to.";
    }

    const token = this.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      console.error("TELEGRAM_BOT_TOKEN is not set, so a Telegram reply can't be sent");
      this.store.outbox.markFailed(op);
      return;
    }
    try {
      await sendTelegramMessage(this.telegramFetch(), token, item.target, text);
      this.store.outbox.markSent(op);
    } catch (error) {
      const attempts = this.store.outbox.recordFailedSend(op);
      console.error(JSON.stringify({ event: "telegram_send_failed", op, attempts, error: errorMessage(error) }));
      if (attempts >= timing.sendAttempts) this.store.outbox.markFailed(op);
      else await this.schedule(timing.recheckSeconds * attempts, "deliverTelegramReply", { op });
    }
  }

  /** The operation's result if it settles within `ms`, otherwise undefined. */
  async #settled(op: string, ms: number): Promise<OperationResult | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await this.pi.runtime.wait(op, { conversation: ROOT_CONVERSATION, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return undefined;
      throw error;
    } finally {
      // A pending timer keeps the object awake, and billed, after the reply has gone.
      clearTimeout(timer);
    }
  }

  // The wire carries only Fennec's protocol: no identity, state or MCP frames.
  override shouldSendProtocolMessages(): boolean {
    return false;
  }

  // Clients may not write Agent state; Fennec does not use it.
  override shouldConnectionBeReadonly(): boolean {
    return true;
  }

  // Fennec has no sub-agents. The edge forwards only the exact /chat path, and
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
