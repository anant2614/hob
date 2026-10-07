import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent, EntryRecord, MessageChange, SnapshotEvent } from "@earendil-works/pi-durable";
import { projectEntries, projectEntry, projectMessage, type MessagePart, type TranscriptMessage } from "./transcript";

// Folds Pi's agent events (protocol pi-events/1) into what the UI shows.
// Adapted from Cloudflare's Pi example (view.ts), plus spend, compaction,
// errors and "resuming". Pure, so the tests run the same code.

/** A tool call running now, with its streamed output. */
export type RunningTool = { readonly callId: string; readonly name: string; readonly output: string };

export type HobView = {
  readonly messages: readonly TranscriptMessage[];
  /** The assistant message being streamed, or null. */
  readonly live: TranscriptMessage | null;
  readonly running: boolean;
  readonly tools: readonly RunningTool[];
  /** Inputs queued behind the running work. */
  readonly queued: number;
  /** A retry backoff Pi is waiting out. */
  readonly retry: { readonly at: number; readonly error: string } | null;
  /** Compaction tasks in progress. */
  readonly compactions: readonly number[];
  readonly compacting: boolean;
  /** This conversation's spend so far, as Pi's usage ledger reports it. */
  readonly usage: { readonly cost: number; readonly tokens: number };
  readonly error: string | null;
  /** The socket dropped mid-run; true until the run visibly moves again. */
  readonly resuming: boolean;
};

export const EMPTY_VIEW: HobView = {
  messages: [],
  live: null,
  running: false,
  tools: [],
  queued: 0,
  retry: null,
  compactions: [],
  compacting: false,
  usage: { cost: 0, tokens: 0 },
  error: null,
  resuming: false
};

/** Not from Pi: the client's own note that its socket closed. */
export type ConnectionEvent = { readonly type: "disconnected" };

const LIVE_ID = "live";

type UsageLedger = SnapshotEvent["usage"];

function totalUsage(ledger: UsageLedger): HobView["usage"] {
  let cost = 0;
  let tokens = 0;
  for (const bucket of [ledger.models, ledger.tools]) {
    for (const usage of Object.values(bucket)) {
      cost += usage.cost?.total ?? 0;
      tokens += usage.totalTokens ?? 0;
    }
  }
  return { cost, tokens };
}

function unansweredMessage(reason: string | undefined, detail: unknown): string | null {
  switch (reason) {
    // The owner stopped it, or a new topic replaced it: not a failure.
    case "aborted":
    case "withdrawn":
    case "reset":
    case "stale":
      return null;
    case "no_model":
      return "Hob has no model to answer with. Check MODEL_ID in wrangler.jsonc.";
    case "model_error":
      return typeof detail === "string" && detail !== ""
        ? `The model call failed: ${detail}`
        : "The model call failed. Check the AI Gateway logs.";
    case undefined:
      return "Hob couldn't answer that.";
    default:
      return `Hob couldn't answer that (${reason}).`;
  }
}

function append(view: HobView, entry: EntryRecord): HobView {
  const message = projectEntry(entry);
  if (!message) return view;
  // A reset starts a new context, and a snapshot shows only the active one.
  if (entry.kind === "pi.reset") return { ...view, messages: [message] };
  if (view.messages.some((known) => known.id === message.id)) return view;
  return { ...view, messages: [...view.messages, message] };
}

function blockPart(block: AssistantMessage["content"][number]): MessagePart | undefined {
  const message = { role: "assistant", content: [block], stopReason: "stop", timestamp: 0 } as unknown as AssistantMessage;
  return projectMessage(message, LIVE_ID).parts[0];
}

function applyChanges(live: TranscriptMessage | null, changes: readonly MessageChange[]): TranscriptMessage | null {
  let message = live;
  for (const change of changes) {
    if (change.type === "message") {
      message = projectMessage(change.message, LIVE_ID);
      continue;
    }
    if (!message) continue;
    const parts = [...message.parts];
    const previous = parts[change.contentIndex];
    switch (change.type) {
      case "text_start":
      case "thinking_start":
      case "toolcall_start":
      case "block": {
        const part = blockPart(change.block);
        if (part) parts[change.contentIndex] = part;
        break;
      }
      case "text_delta":
        parts[change.contentIndex] = { type: "text", text: (previous?.type === "text" ? previous.text : "") + change.delta };
        break;
      case "thinking_delta":
        parts[change.contentIndex] = {
          type: "thinking",
          text: (previous?.type === "thinking" ? previous.text : "") + change.delta
        };
        break;
      case "toolcall_delta":
        // Partial argument JSON; the call renders once its block completes.
        break;
    }
    message = { ...message, parts };
  }
  return message;
}

function withCompactions(view: HobView, compactions: readonly number[]): HobView {
  return { ...view, compactions, compacting: compactions.length > 0 };
}

export function reduceView(view: HobView, event: AgentEvent | ConnectionEvent): HobView {
  switch (event.type) {
    case "disconnected":
      return { ...view, resuming: view.running };
    case "snapshot": {
      const partial = event.generation?.message;
      const running = event.run !== undefined;
      return {
        messages: projectEntries(event.entries),
        live: partial ? projectMessage(partial, LIVE_ID) : null,
        running,
        tools: event.tools
          .filter((slot) => slot.status === "running")
          .map((slot) => ({ callId: slot.callId, name: slot.name, output: slot.output ?? "" })),
        queued: event.inbox.length,
        retry: event.generation?.retry ?? null,
        compactions: event.compactions.map((compaction) => Number(compaction.taskId)),
        compacting: event.compactions.length > 0,
        usage: totalUsage(event.usage),
        error: null,
        resuming: view.resuming && running
      };
    }
    case "run_start":
      return { ...view, running: true, error: null, resuming: false };
    case "run_end":
      return { ...view, running: false, live: null, tools: [], retry: null, resuming: false };
    case "message_start":
      return event.message.role === "assistant"
        ? { ...view, live: projectMessage(event.message, LIVE_ID), resuming: false }
        : view;
    case "message_update":
      return { ...view, live: applyChanges(view.live, event.changes), resuming: false };
    case "message_end": {
      const next = append(view, event.entry);
      return event.entry.model?.[0]?.role === "assistant" ? { ...next, live: null } : next;
    }
    case "entry_appended":
      return append(view, event.entry);
    case "tool_execution_start":
      return {
        ...view,
        resuming: false,
        tools: [
          ...view.tools.filter((tool) => tool.callId !== event.toolCallId),
          { callId: event.toolCallId, name: event.toolName, output: "" }
        ]
      };
    case "tool_execution_update": {
      const output = event.output;
      if (!output) return { ...view, resuming: false };
      return {
        ...view,
        resuming: false,
        tools: view.tools.map((tool) => {
          if (tool.callId !== event.toolCallId) return tool;
          if ("set" in output) return { ...tool, output: output.set };
          return { ...tool, output: tool.output.slice(output.trimStart ?? 0) + (output.append ?? "") };
        })
      };
    }
    case "tool_execution_end":
      return { ...view, resuming: false, tools: view.tools.filter((tool) => tool.callId !== event.toolCallId) };
    case "inbox_update":
      return { ...view, queued: event.items.length };
    case "auto_retry_start":
      return { ...view, retry: { at: event.at, error: event.errorMessage } };
    case "auto_retry_end":
      return { ...view, retry: null };
    case "usage_changed":
      return { ...view, usage: totalUsage(event.usage) };
    case "compaction_start":
      return withCompactions(view, [...view.compactions.filter((id) => id !== Number(event.taskId)), Number(event.taskId)]);
    case "compaction_end":
      return withCompactions(
        view,
        view.compactions.filter((id) => id !== Number(event.taskId))
      );
    case "task_failed":
      return { ...view, error: `Something went wrong inside Hob: ${event.message}` };
    case "submission":
      return event.record.status === "unanswered"
        ? { ...view, error: unansweredMessage(event.record.reason, event.record.detail) ?? view.error }
        : view;
    default:
      return view;
  }
}

export function reduceEvents(view: HobView, events: readonly (AgentEvent | ConnectionEvent)[]): HobView {
  return events.reduce(reduceView, view);
}
