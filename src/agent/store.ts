import { normalizeHost } from "../tools/hosts";

// Hob's own state, in `app_*` tables beside Pi's `pi_*` tables in the same
// Durable Object database. Nothing here depends on the harness, so it survives
// a harness swap unchanged.

export const MAX_MEMORIES = 100;
export const MAX_MEMORY_TEXT = 1000;
const MAX_KEY = 64;

export type MemorySource = "owner" | "agent";

export type MemoryItem = {
  readonly key: string;
  readonly text: string;
  readonly source: MemorySource;
  /** Written while the conversation held untrusted content, so it may be injected. */
  readonly tainted: boolean;
  readonly updatedAt: number;
};

export type MemoryResult = { readonly ok: true; readonly item: MemoryItem } | { readonly ok: false; readonly error: string };

export type StoreChange = { readonly kind: "memory" } | { readonly kind: "taint"; readonly conversation: string };

/** Lowercase, words joined by `-`, only `[a-z0-9._-]`, 1–64 characters; null when nothing usable is left. */
export function normalizeKey(raw: string): string | null {
  const key = raw
    .toLowerCase()
    .replace(/[^a-z0-9._\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return key.length === 0 || key.length > MAX_KEY ? null : key;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS app_memory (
    key TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    tainted INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS app_conversation (
    conversation TEXT PRIMARY KEY,
    tainted_since INTEGER,
    taint_source TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS app_owner_host (
    conversation TEXT NOT NULL,
    host TEXT NOT NULL,
    PRIMARY KEY (conversation, host)
  )`
];

type MemoryRow = { key: string; text: string; source: string; tainted: number; updated_at: number };

function toItem(row: MemoryRow): MemoryItem {
  return {
    key: row.key,
    text: row.text,
    source: row.source === "owner" ? "owner" : "agent",
    tainted: row.tainted === 1,
    updatedAt: row.updated_at
  };
}

/** One line, and no way to close or open a tag in the prompt section around it. */
function promptSafe(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/</g, "&lt;");
}

export class AppStore {
  readonly #sql: SqlStorage;
  readonly #listeners = new Set<(change: StoreChange) => void>();

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    for (const statement of SCHEMA) this.#sql.exec(statement);
  }

  /** Observe changes the UI should hear about. Returns a function that stops observing. */
  onChange(listener: (change: StoreChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(change: StoreChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        console.error("store listener failed", error);
      }
    }
  }

  readonly memory = {
    list: (): MemoryItem[] =>
      this.#sql
        .exec<MemoryRow>("SELECT key, text, source, tainted, updated_at FROM app_memory ORDER BY key")
        .toArray()
        .map(toItem),

    set: (rawKey: string, rawText: string, options: { source: MemorySource; tainted: boolean }): MemoryResult => {
      const key = normalizeKey(rawKey);
      if (key === null) {
        return { ok: false, error: `Keys are 1–${MAX_KEY} characters of letters, digits, ".", "_" or "-".` };
      }
      const text = rawText.trim();
      if (text.length === 0) return { ok: false, error: "The text to remember is empty." };
      if (text.length > MAX_MEMORY_TEXT) {
        return { ok: false, error: `The text is ${text.length} characters; the limit is ${MAX_MEMORY_TEXT}. Shorten it.` };
      }
      const exists = this.#sql.exec("SELECT 1 FROM app_memory WHERE key = ?", key).toArray().length > 0;
      if (!exists) {
        const count = this.#sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM app_memory").one().n;
        if (count >= MAX_MEMORIES) {
          return { ok: false, error: `Memory is full (${MAX_MEMORIES} items). Forget something first.` };
        }
      }
      const updatedAt = Date.now();
      this.#sql.exec(
        `INSERT INTO app_memory (key, text, source, tainted, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET text = excluded.text, source = excluded.source,
           tainted = excluded.tainted, updated_at = excluded.updated_at`,
        key,
        text,
        options.source,
        options.tainted ? 1 : 0,
        updatedAt
      );
      this.#emit({ kind: "memory" });
      return { ok: true, item: { key, text, source: options.source, tainted: options.tainted, updatedAt } };
    },

    delete: (rawKey: string): boolean => {
      const key = normalizeKey(rawKey);
      if (key === null) return false;
      const deleted = this.#sql.exec("DELETE FROM app_memory WHERE key = ?", key).rowsWritten > 0;
      if (deleted) this.#emit({ kind: "memory" });
      return deleted;
    },

    /** The memory as the model sees it before every request. */
    renderForPrompt: (): string => {
      const items = this.memory.list();
      if (items.length === 0) return "No memories saved yet.";
      return items
        .map(
          (item) =>
            `- [${item.key}] ${promptSafe(item.text)}${
              item.tainted ? " (saved after reading untrusted content; unconfirmed)" : ""
            }`
        )
        .join("\n");
    }
  };

  readonly conversations = {
    isTainted: (conversation: string): boolean =>
      this.#sql
        .exec("SELECT 1 FROM app_conversation WHERE conversation = ? AND tainted_since IS NOT NULL", conversation)
        .toArray().length > 0,

    /** Mark the conversation as holding untrusted content. Keeps the first time and source. */
    taint: (conversation: string, source: string): void => {
      if (this.conversations.isTainted(conversation)) return;
      this.#sql.exec(
        `INSERT INTO app_conversation (conversation, tainted_since, taint_source) VALUES (?, ?, ?)
         ON CONFLICT(conversation) DO UPDATE SET tainted_since = excluded.tainted_since, taint_source = excluded.taint_source`,
        conversation,
        Date.now(),
        source
      );
      this.#emit({ kind: "taint", conversation });
    },

    /** Record hosts the owner named in their own message. */
    addOwnerHosts: (conversation: string, hosts: readonly string[]): void => {
      for (const host of hosts) {
        this.#sql.exec(
          "INSERT OR IGNORE INTO app_owner_host (conversation, host) VALUES (?, ?)",
          conversation,
          normalizeHost(host)
        );
      }
    },

    /** Whether the owner named this host, or a parent domain of it, in this conversation. */
    hasOwnerHost: (conversation: string, host: string): boolean => {
      const wanted = normalizeHost(host);
      return this.#sql
        .exec<{ host: string }>("SELECT host FROM app_owner_host WHERE conversation = ?", conversation)
        .toArray()
        .some(({ host: named }) => wanted === named || wanted.endsWith(`.${named}`));
    },

    /** A new context: the untrusted content and the owner's mentions are gone from what the model sees. */
    reset: (conversation: string): void => {
      const wasTainted = this.conversations.isTainted(conversation);
      this.#sql.exec("DELETE FROM app_conversation WHERE conversation = ?", conversation);
      this.#sql.exec("DELETE FROM app_owner_host WHERE conversation = ?", conversation);
      if (wasTainted) this.#emit({ kind: "taint", conversation });
    }
  };
}
