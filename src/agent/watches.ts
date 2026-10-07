import type { ServerMessage } from "../shared/protocol";
import type { EventStream } from "./runtime";

/** `WebSocket.OPEN`; the constant is not defined on every runtime's global. */
const OPEN = 1;

/**
 * One live event watch per socket, adapted from Cloudflare's Pi example
 * (sockets.ts #watch/#unwatch). Watches live in memory: after an eviction the
 * host re-watches every socket from onStart, and the client replaces its state
 * with the fresh snapshot. A socket that closes must be unwatched, or its
 * watch leaks.
 */
export class Watches {
  readonly #open: (conversation: string) => Promise<EventStream>;
  readonly #send: (socket: WebSocket, message: ServerMessage) => void;
  readonly #watches = new Map<WebSocket, EventStream>();
  /** Watch changes per socket, one at a time, so racing re-watches cannot leak a stream. */
  readonly #queues = new Map<WebSocket, Promise<void>>();

  constructor(
    open: (conversation: string) => Promise<EventStream>,
    send: (socket: WebSocket, message: ServerMessage) => void
  ) {
    this.#open = open;
    this.#send = send;
  }

  get size(): number {
    return this.#watches.size;
  }

  /** (Re)start the socket's watch: a snapshot first, then one batch per change. */
  watch(socket: WebSocket, conversation: string): Promise<void> {
    return this.#serial(socket, async () => {
      await this.#stop(socket);
      const stream = await this.#open(conversation);
      this.#watches.set(socket, stream);
      this.#send(socket, { type: "events", conversation, events: [stream.snapshot] });
      stream.start(async (events) => {
        if (socket.readyState !== OPEN) {
          void this.unwatch(socket);
          return;
        }
        this.#send(socket, { type: "events", conversation, events });
      });
    });
  }

  unwatch(socket: WebSocket): Promise<void> {
    return this.#serial(socket, () => this.#stop(socket));
  }

  async #stop(socket: WebSocket): Promise<void> {
    const stream = this.#watches.get(socket);
    if (stream === undefined) return;
    this.#watches.delete(socket);
    await stream.stop();
  }

  #serial(socket: WebSocket, step: () => Promise<void>): Promise<void> {
    const previous = this.#queues.get(socket) ?? Promise.resolve();
    const next = previous.then(step, step);
    const settled = next.catch(() => undefined);
    this.#queues.set(socket, settled);
    void settled.then(() => {
      if (this.#queues.get(socket) === settled) this.#queues.delete(socket);
    });
    return next;
  }
}
