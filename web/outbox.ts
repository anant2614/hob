import type { ClientMessage, ServerMessage } from "../src/shared/protocol";

export type SubmitMessage = Extract<ClientMessage, { type: "submit" }> & { readonly id: string };

/**
 * Submissions the agent hasn't answered yet. A socket can look open and still
 * lose a frame, as when a phone wakes from sleep, so each one is kept until
 * its `result` or `error` arrives and is sent again on the next socket.
 * Sending twice is safe: the agent dedupes submissions by operationId.
 */
export class Outbox {
  readonly #pending = new Map<string, { readonly message: SubmitMessage; sentAt: number }>();

  add(message: SubmitMessage, now: number): void {
    this.#pending.set(message.id, { message, sentAt: now });
  }

  /** The agent answered `id`. Whether it was waiting. */
  settle(id: string): boolean {
    return this.#pending.delete(id);
  }

  /** The unanswered submissions, oldest first, to send on a new socket. Their clocks restart. */
  resend(now: number): SubmitMessage[] {
    return [...this.#pending.values()].map((entry) => {
      entry.sentAt = now;
      return entry.message;
    });
  }

  /** Whether one has waited longer than `ms`: the socket is probably dead, however open it looks. */
  overdue(now: number, ms: number): boolean {
    for (const { sentAt } of this.#pending.values()) if (now - sentAt > ms) return true;
    return false;
  }
}

/** Requests whose caller waits for the answer, such as a memory edit. */
export class Requests {
  readonly #waiting = new Map<string, { resolve(result: unknown): void; reject(error: Error): void }>();

  /** The answer to the message with this id. */
  wait(id: string): Promise<unknown> {
    return new Promise((resolve, reject) => this.#waiting.set(id, { resolve, reject }));
  }

  /** Settle the request a `result` or `error` frame answers. Whether there was one. */
  settle(frame: ServerMessage<unknown>): boolean {
    if ((frame.type !== "result" && frame.type !== "error") || frame.id === undefined) return false;
    const waiting = this.#waiting.get(frame.id);
    if (waiting === undefined) return false;
    this.#waiting.delete(frame.id);
    if (frame.type === "result") waiting.resolve(frame.result);
    else waiting.reject(new Error(frame.message));
    return true;
  }

  /** Fail everything still waiting, as when the socket drops: those answers will never come. */
  failAll(message: string): void {
    for (const { reject } of this.#waiting.values()) reject(new Error(message));
    this.#waiting.clear();
  }
}
