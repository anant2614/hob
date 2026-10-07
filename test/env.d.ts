import type { SqlTestObject } from "./worker";

// Test-only bindings, on both spellings of Env so they stay interchangeable.
declare global {
  interface Env {
    SQL_TEST: DurableObjectNamespace<SqlTestObject>;
  }
  namespace Cloudflare {
    interface Env {
      SQL_TEST: DurableObjectNamespace<SqlTestObject>;
    }
  }
}

export {};
