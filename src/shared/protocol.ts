// The WebSocket protocol between the browser and the agent. Shared by the
// Worker and the web app. The `events` frames carry the harness's own events;
// PROTOCOL names their format, so a neutral format can replace Pi's later
// without guessing what a client understands.

export const PROTOCOL = "pi-events/1";
/** v0 has one conversation: Pi's root session. */
export const ROOT_CONVERSATION = "1";
export const MAX_INPUT_CHARS = 32_000;
const MAX_ID = 128;
const MAX_KEY_INPUT = 256;
const MAX_MEMORY_INPUT = 4_000;

export type WhenBusy = "followUp" | "steer";

export type MemoryItem = {
  readonly key: string;
  readonly text: string;
  readonly source: "owner" | "agent";
  /** Written while the conversation held untrusted content, so it may be injected. */
  readonly tainted: boolean;
  readonly updatedAt: number;
};

export type ToolInfo = { readonly name: string; readonly description: string };

/** Browser → agent. Messages with an `id` get a `result` or an `error` back. */
export type ClientMessage =
  | {
      readonly type: "submit";
      readonly id?: string;
      readonly input: string;
      /** Idempotency key: resending the same operation is a no-op. */
      readonly operationId?: string;
      readonly whenBusy?: WhenBusy;
    }
  | { readonly type: "abort"; readonly id?: string }
  /** Start a new topic: stop the run, then start a fresh context. */
  | { readonly type: "reset"; readonly id?: string; readonly handoff?: string }
  /** Ask for a fresh snapshot. */
  | { readonly type: "resync"; readonly id?: string }
  | { readonly type: "memory_set"; readonly id?: string; readonly key: string; readonly text: string }
  | { readonly type: "memory_delete"; readonly id?: string; readonly key: string };

/** Agent → browser. `E` is the event type that PROTOCOL names. */
export type ServerMessage<E = unknown> =
  | {
      readonly type: "hello";
      readonly protocol: typeof PROTOCOL;
      readonly conversation: string;
      readonly tools: readonly ToolInfo[];
      readonly model: string;
    }
  /** The first batch of a watch, and any batch after the server lost one, starts with a snapshot that replaces the client's state. */
  | { readonly type: "events"; readonly conversation: string; readonly events: readonly E[] }
  | { readonly type: "memory"; readonly items: readonly MemoryItem[] }
  | { readonly type: "taint"; readonly conversation: string; readonly tainted: boolean }
  | { readonly type: "result"; readonly id: string; readonly result: unknown }
  | { readonly type: "error"; readonly id?: string; readonly message: string };

type Fields = Record<string, unknown>;

function optionalString(fields: Fields, name: string, max: number): string | undefined | null {
  const value = fields[name];
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length <= max ? value : null;
}

function requiredString(fields: Fields, name: string, max: number): string | null {
  const value = fields[name];
  return typeof value === "string" && value.length <= max ? value : null;
}

/** Validate one frame from the browser. Never throws. */
export function parseClientMessage(raw: unknown): ClientMessage | { readonly error: string } {
  if (typeof raw !== "string") return { error: "Expected a text frame" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "Malformed JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { error: "Expected an object" };
  const fields = parsed as Fields;
  const id = optionalString(fields, "id", MAX_ID);
  if (id === null) return { error: "Invalid id" };
  const withId = id === undefined ? {} : { id };

  switch (fields.type) {
    case "submit": {
      const input = requiredString(fields, "input", MAX_INPUT_CHARS);
      if (input === null || input.trim() === "") return { error: `input must be 1–${MAX_INPUT_CHARS} characters` };
      const operationId = optionalString(fields, "operationId", MAX_ID);
      if (operationId === null) return { error: "Invalid operationId" };
      const whenBusy = fields.whenBusy;
      if (whenBusy !== undefined && whenBusy !== "followUp" && whenBusy !== "steer") return { error: "Invalid whenBusy" };
      return {
        type: "submit",
        ...withId,
        input,
        ...(operationId === undefined ? {} : { operationId }),
        ...(whenBusy === undefined ? {} : { whenBusy })
      };
    }
    case "abort":
      return { type: "abort", ...withId };
    case "resync":
      return { type: "resync", ...withId };
    case "reset": {
      const handoff = optionalString(fields, "handoff", MAX_INPUT_CHARS);
      if (handoff === null) return { error: "Invalid handoff" };
      return { type: "reset", ...withId, ...(handoff === undefined ? {} : { handoff }) };
    }
    case "memory_set": {
      const key = requiredString(fields, "key", MAX_KEY_INPUT);
      const text = requiredString(fields, "text", MAX_MEMORY_INPUT);
      if (key === null || text === null) return { error: "memory_set needs a key and a text" };
      return { type: "memory_set", ...withId, key, text };
    }
    case "memory_delete": {
      const key = requiredString(fields, "key", MAX_KEY_INPUT);
      if (key === null) return { error: "memory_delete needs a key" };
      return { type: "memory_delete", ...withId, key };
    }
    default:
      return { error: `Unknown message type ${JSON.stringify(fields.type)}` };
  }
}
