import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";

/** Run `fn` against the SQLite storage of a fresh, empty Durable Object. */
export function withSql<T>(fn: (sql: SqlStorage) => T | Promise<T>): Promise<T> {
  const stub = env.SQL_TEST.getByName(crypto.randomUUID());
  return runInDurableObject(stub, (_instance, state) => fn(state.storage.sql));
}
