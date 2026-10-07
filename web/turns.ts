import type { JsonValue } from "@earendil-works/pi-ai";
import type { MessagePart, TranscriptMessage } from "./transcript";

export type ToolResult = Extract<MessagePart, { type: "tool-result" }>;

/** The logbook's rows: what you said, what Hob did and said, and notices such as "New topic". */
export type Turn =
  | { readonly kind: "you"; readonly id: string; readonly message: TranscriptMessage }
  | { readonly kind: "hob"; readonly id: string; readonly messages: readonly TranscriptMessage[] }
  | { readonly kind: "notice"; readonly id: string; readonly text: string };

export function textOf(message: TranscriptMessage): string {
  return message.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Group a transcript into turns: each run of Hob's messages and tool results becomes one turn. */
export function groupTurns(messages: readonly TranscriptMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ kind: "you", id: message.id, message });
    } else if (message.role === "notice") {
      const text = textOf(message);
      if (text !== "") turns.push({ kind: "notice", id: message.id, text });
    } else {
      const last = turns.at(-1);
      if (last?.kind === "hob") turns[turns.length - 1] = { ...last, messages: [...last.messages, message] };
      else turns.push({ kind: "hob", id: message.id, messages: [message] });
    }
  }
  return turns;
}

/** Every tool result in the transcript, by the id of the call it answers. */
export function resultsByCall(messages: readonly TranscriptMessage[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const message of messages) {
    for (const part of message.parts) if (part.type === "tool-result") results.set(part.id, part);
  }
  return results;
}

export type ToolTone = "done" | "running" | "failed" | "refused" | "stopped";
export type ToolNote = { readonly label: string; readonly tone: ToolTone; readonly icon: "remember" | "forget" | "read" | "tool" };

function argument(args: JsonValue, name: string): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "";
  const value = (args as Record<string, JsonValue>)[name];
  return typeof value === "string" ? value : "";
}

/** A URL as people read it: host and path, without the scheme or a trailing slash. */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    const short = `${parsed.hostname.replace(/^www\./, "")}${path}`;
    return short.length > 48 ? `${short.slice(0, 47)}…` : short;
  } catch {
    return url;
  }
}

export function resultText(result: ToolResult | undefined): string {
  return (result?.content ?? []).map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

/** One line, in plain words, for a tool call: what Hob did, is doing, or could not do. */
export function describeTool(name: string, args: JsonValue, result: ToolResult | undefined, running: boolean): ToolNote {
  const text = resultText(result);
  // Pi's own wording when the owner stopped the call.
  const stopped = result?.error === true && / was aborted$/m.test(text);
  const tone: ToolTone = running
    ? "running"
    : result === undefined
      ? "running"
      : stopped
        ? "stopped"
        : result.error
          ? "failed"
          : "done";
  switch (name) {
    case "remember": {
      const key = argument(args, "key");
      if (tone === "running") return { icon: "remember", tone, label: `Saving “${key}”` };
      if (tone === "stopped") return { icon: "remember", tone, label: `Stopped saving “${key}”` };
      if (tone === "failed") return { icon: "remember", tone, label: `Couldn't save “${key}”` };
      return { icon: "remember", tone, label: `Saved “${key}”` };
    }
    case "forget": {
      const key = argument(args, "key");
      if (tone === "running") return { icon: "forget", tone, label: `Forgetting “${key}”` };
      if (tone === "stopped") return { icon: "forget", tone, label: `Stopped forgetting “${key}”` };
      if (tone === "failed") return { icon: "forget", tone, label: `Couldn't forget “${key}”` };
      if (text.startsWith("Nothing was saved")) return { icon: "forget", tone, label: `Nothing to forget for “${key}”` };
      return { icon: "forget", tone, label: `Forgot “${key}”` };
    }
    case "read_page": {
      const url = shortUrl(argument(args, "url"));
      if (tone === "running") return { icon: "read", tone, label: `Reading ${url}` };
      if (tone === "stopped") return { icon: "read", tone, label: `Stopped reading ${url}` };
      if (tone === "failed" && text.startsWith("Not fetched")) {
        return { icon: "read", tone: "refused", label: `Didn't open ${url}` };
      }
      if (tone === "failed") return { icon: "read", tone, label: `Couldn't read ${url}` };
      return { icon: "read", tone, label: `Read ${url}` };
    }
    default:
      return {
        icon: "tool",
        tone,
        label: tone === "failed" ? `${name} failed` : tone === "stopped" ? `${name} stopped` : name
      };
  }
}

/** A result for people: the untrusted wrapper removed, since the note already says where it came from. */
export function readableResult(text: string): string {
  return text.replace(/^<untrusted source="[^"]*">\n?/, "").replace(/\n?<\/untrusted>$/, "");
}

/** Spend as people read it. */
export function formatCost(cost: number): string {
  if (cost <= 0) return "$0.00";
  if (cost < 0.01) return "under $0.01";
  return `$${cost.toFixed(2)}`;
}
