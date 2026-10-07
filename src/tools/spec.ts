// Harness-neutral tool contract. Tools are written once against these types
// and compiled into a harness's own tool format by the adapter (today
// src/harness/pi.ts), always through Policy.run.

/** What a call can change, which drives replay, ordering and approval. */
export type Effect = "read" | "idempotent-write" | "side-effect";

export interface ToolCtx {
  /** Aborted when the owner presses Stop or the run is aborted. Pass it to every fetch. */
  readonly signal: AbortSignal;
  /** Stable across crash replays of the same call. */
  readonly idempotencyKey: string;
  /** The conversation (Pi session) the call belongs to. */
  readonly conversation: string;
  /** Whether the conversation has seen untrusted third-party content. */
  readonly tainted: boolean;
  /** Stream running output to the UI. */
  output(chunk: string): void;
  /**
   * Why Hob may not contact `url` now, or undefined when it may. Policy checks
   * a tool's declared `egress` before it runs; a tool that reaches further
   * hosts, such as redirect targets, asks here before each one.
   */
  checkEgress(url: string): string | undefined;
}

export interface ToolOutput {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError?: boolean;
  /** Set when the content came from a third party; Policy labels it and taints the conversation. */
  readonly untrusted?: { readonly source: string };
}

export interface ToolSpec<A = any> {
  readonly name: string;
  readonly description: string;
  /** Plain JSON Schema for the arguments. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly effect: Effect;
  /** Calls share state (a browser tab, a sandbox), so a round containing one runs one call at a time. */
  readonly sequential?: boolean;
  /** The URL this call would contact, if any. Policy checks it while a conversation is tainted. */
  egress?(args: A): string | undefined;
  execute(args: A, ctx: ToolCtx): Promise<ToolOutput>;
}

export function textOutput(text: string, isError = false): ToolOutput {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}
