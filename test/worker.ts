import { DurableObject } from "cloudflare:workers";

/** A bare SQLite-backed object, for tests that need real Durable Object storage. */
export class SqlTestObject extends DurableObject {}

export default { fetch: () => new Response("Not found", { status: 404 }) };
