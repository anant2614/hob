import type { SqlTestObject } from "./worker";

declare global {
  namespace Cloudflare {
    interface Env {
      SQL_TEST: DurableObjectNamespace<SqlTestObject>;
    }
  }
}

export {};
