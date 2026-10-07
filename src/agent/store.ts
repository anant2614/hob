import type { MemoryItem } from "../shared/protocol";
import { normalizeHost } from "../tools/hosts";

export type { MemoryItem };

// Hob's own state, in `app_*` tables beside Pi's `pi_*` tables in the same
// Durable Object database. Nothing here depends on the harness, so it survives
// a harness swap unchanged.

export const MAX_MEMORIES = 100;
export const MAX_MEMORY_TEXT = 1000;
const MAX_KEY = 64;

export type MemorySource = MemoryItem["source"];

export type MemoryResult = { readonly ok: true; readonly item: MemoryItem } | { readonly ok: false; readonly error: string };

export type StoreChange = { readonly kind: "memory" } | { readonly kind: "taint"; readonly conversation: string };

/** Lowercase, words joined by `-`, only letters, digits and `._-` (any script), 1–64 characters; null when nothing usable is left. */
export function normalizeKey(raw: string): string | null {
  const key = raw
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}._\s-]/gu, "")
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
  )`,
  `CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // The version of the app_* tables, for the first migration to read.
  `INSERT OR IGNORE INTO app_meta (key, value) VALUES ('schema', '1')`
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

    get: (rawKey: string): MemoryItem | undefined => {
      const key = normalizeKey(rawKey);
      if (key === null) return undefined;
      const row = this.#sql
        .exec<MemoryRow>("SELECT key, text, source, tainted, updated_at FROM app_memory WHERE key = ?", key)
        .toArray()[0];
      return row === undefined ? undefined : toItem(row);
    },

    /** Whether a memory saved after reading untrusted content still waits for the owner to keep or delete it. */
    hasUnconfirmed: (): boolean => this.#sql.exec("SELECT 1 FROM app_memory WHERE tainted = 1 LIMIT 1").toArray().length > 0,

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

  /** Small settings, such as the schema version and the model last applied to the conversation. */
  readonly meta = {
    get: (key: string): string | undefined =>
      this.#sql.exec<{ value: string }>("SELECT value FROM app_meta WHERE key = ?", key).toArray()[0]?.value,

    set: (key: string, value: string): void => {
      this.#sql.exec(
        "INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        key,
        value
      );
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

    /**
     * Whether the owner named exactly this host (`www.` aside) in this conversation.
     * Not its subdomains: naming workers.dev must not open every *.workers.dev.
     */
    hasOwnerHost: (conversation: string, host: string): boolean =>
      this.#sql
        .exec("SELECT 1 FROM app_owner_host WHERE conversation = ? AND host = ?", conversation, normalizeHost(host))
        .toArray().length > 0,

    /** A new context: the untrusted content and the owner's mentions are gone from what the model sees. */
    reset: (conversation: string): void => {
      const wasTainted = this.conversations.isTainted(conversation);
      this.#sql.exec("DELETE FROM app_conversation WHERE conversation = ?", conversation);
      this.#sql.exec("DELETE FROM app_owner_host WHERE conversation = ?", conversation);
      if (wasTainted) this.#emit({ kind: "taint", conversation });
    }
  };
}
