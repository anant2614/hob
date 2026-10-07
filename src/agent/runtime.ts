// The harness port. The agent and its channels talk to whatever runs the
// agent loop through these types only. The shape copies Cloudflare's draft
// AgentHarness/HarnessSession interface (submit / wait / abort / reset /
// watch); it is copied rather than imported because that file exists only on
// the agents main branch.

export type WhenBusy = "followUp" | "steer";

export type Receipt = {
  readonly operationId: string;
  readonly conversation: string;
  /** False when this operation id was already submitted, e.g. a client retry. */
  readonly accepted: boolean;
};

export type OperationResult = {
  readonly operationId: string;
  readonly conversation: string;
  readonly status: "done" | "unanswered";
  readonly reason?: string;
  readonly text?: string;
};

export interface AgentRuntime {
  /** Durably admit input. Resolves before the model runs. */
  submit(
    input: string,
    options?: { readonly conversation?: string; readonly operationId?: string; readonly whenBusy?: WhenBusy }
  ): Promise<Receipt>;
  /** Wait for an operation to settle. Aborting `signal` stops only the wait. */
  wait(
    operationId: string,
    options?: { readonly conversation?: string; readonly signal?: AbortSignal }
  ): Promise<OperationResult>;
  /** Withdraw one operation, or stop everything running in the conversation. */
  abort(options?: { readonly conversation?: string; readonly operationId?: string }): Promise<boolean>;
  /** Start a new context, optionally from a handoff note. */
  reset(options?: { readonly conversation?: string; readonly handoff?: string }): Promise<void>;
}

/**
 * A live view of one conversation: a snapshot, then one batch of events per
 * change. The events are the harness's own; their format is named by the wire
 * protocol version (see src/shared/protocol.ts).
 */
export interface EventStream {
  readonly snapshot: unknown;
  start(listener: (events: readonly unknown[]) => Promise<void>): void;
  stop(): Promise<unknown>;
}
