import { normalizeKey, type AppStore } from "../agent/store";
import { textOutput, type ToolSpec } from "./spec";

type MemoryStore = Pick<AppStore, "memory">;

export function rememberTool(store: MemoryStore): ToolSpec<{ key: string; text: string }> {
  return {
    name: "remember",
    description:
      'Save or update one durable fact about the owner in long-term memory, under a short key such as "name", "partner" or "coffee-order". Saving an existing key replaces its text. Saved memories are shown to you before every reply.',
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Short, stable key: lowercase words joined by '-', at most 64 characters." },
        text: { type: "string", description: "The fact in a sentence or two, at most 1000 characters." }
      },
      required: ["key", "text"],
      additionalProperties: false
    },
    effect: "idempotent-write",
    async execute(args, ctx) {
      const result = store.memory.set(args.key, args.text, { source: "agent", tainted: ctx.tainted });
      return result.ok ? textOutput(`Saved memory "${result.item.key}".`) : textOutput(result.error, true);
    }
  };
}

export function forgetTool(store: MemoryStore): ToolSpec<{ key: string }> {
  return {
    name: "forget",
    description: "Delete one memory by its key, when the owner asks you to forget it or it is no longer true.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", description: "The key of the memory to delete." } },
      required: ["key"],
      additionalProperties: false
    },
    effect: "idempotent-write",
    async execute(args) {
      const key = normalizeKey(args.key) ?? args.key;
      return store.memory.delete(args.key) ? textOutput(`Forgot "${key}".`) : textOutput(`Nothing was saved under "${key}".`);
    }
  };
}
