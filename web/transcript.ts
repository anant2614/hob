import type { AssistantMessage, ImageContent, JsonValue, Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";

// The display model for a transcript, adapted from Cloudflare's Pi example.
// The server sends Pi's own entries and events (protocol pi-events/1); the
// browser folds them into these messages.

export type MessagePart =
  | TextContent
  | ImageContent
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly arguments: JsonValue }
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly name: string;
      readonly content: readonly (TextContent | ImageContent)[];
      readonly error: boolean;
    };

export type TranscriptMessage = {
  /** The Pi entry id, or `live` for the message being streamed. */
  readonly id: string;
  readonly role: "user" | "assistant" | "tool" | "notice";
  readonly parts: readonly MessagePart[];
  readonly timestamp: number;
  readonly error?: string;
};

function userParts(content: UserMessage["content"]): MessagePart[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function assistantParts(content: AssistantMessage["content"]): MessagePart[] {
  return content.map((part): MessagePart => {
    switch (part.type) {
      case "text":
        return { type: "text", text: part.text };
      case "thinking":
        return { type: "thinking", text: part.thinking };
      case "toolCall":
        return { type: "tool-call", id: part.id, name: part.name, arguments: part.arguments };
    }
  });
}

export function projectMessage(message: Message, id: string): TranscriptMessage {
  switch (message.role) {
    case "system":
      // Pi records prompt changes as system entries; they are not shown.
      return { id, role: "notice", parts: [], timestamp: 0 };
    case "user":
      return { id, role: "user", parts: userParts(message.content), timestamp: message.timestamp };
    case "assistant":
      return {
        id,
        role: "assistant",
        parts: assistantParts(message.content),
        timestamp: message.timestamp,
        ...(message.stopReason === "error" && message.errorMessage ? { error: message.errorMessage } : {})
      };
    case "toolResult":
      return {
        id,
        role: "tool",
        parts: [
          {
            type: "tool-result",
            id: message.toolCallId,
            name: message.toolName,
            content: message.content,
            error: message.isError
          }
        ],
        timestamp: message.timestamp
      };
  }
}

function notice(entry: EntryRecord, text: string): TranscriptMessage {
  return { id: String(entry.id), role: "notice", parts: [{ type: "text", text }], timestamp: 0 };
}

/** One transcript entry as a message, or nothing for bookkeeping entries. */
export function projectEntry(entry: EntryRecord): TranscriptMessage | undefined {
  if (entry.kind === "pi.reset") return notice(entry, "New topic");
  if (entry.kind === "pi.compaction") return notice(entry, "Older messages were summarised to save space");
  const message = entry.model?.[0];
  if (entry.kind === "pi.system" || message === undefined || message.role === "system") return undefined;
  return projectMessage(message, String(entry.id));
}

export function projectEntries(entries: readonly EntryRecord[]): TranscriptMessage[] {
  return entries.flatMap((entry) => {
    const message = projectEntry(entry);
    return message ? [message] : [];
  });
}
