import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true
});

// `from "…"` (imports and re-exports), `import "…"`, `import("…")` and `require("…")`.
const HARNESS_IMPORT =
  /(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*["'](@earendil-works\/[^"']+|agents\/harness[^"']*|agents\/models[^"']*)["']/g;

/** The Pi and harness modules a source file imports, in any form. */
function harnessImports(text: string): string[] {
  return [...text.matchAll(HARNESS_IMPORT)].map((match) => match[1] ?? "");
}

describe("the harness boundary", () => {
  it("finds the source files", () => {
    expect(Object.keys(sources)).toContain("../src/harness/pi.ts");
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it("spots static, type, side-effect, dynamic and re-exported imports", () => {
    const text = [
      `import { createModels } from "@earendil-works/pi-ai/models";`,
      `import type { AgentEvent } from '@earendil-works/pi-durable';`,
      `import "@earendil-works/pi-telemetry";`,
      `const pi = await import("agents/harness/pi");`,
      `export * from "agents/models/pi-ai";`,
      `const legacy = require("@earendil-works/chord");`,
      `import { Agent } from "agents";`,
      `import { useAgent } from "agents/react";`
    ].join("\n");
    expect(harnessImports(text)).toEqual([
      "@earendil-works/pi-ai/models",
      "@earendil-works/pi-durable",
      "@earendil-works/pi-telemetry",
      "agents/harness/pi",
      "agents/models/pi-ai",
      "@earendil-works/chord"
    ]);
  });

  it("keeps every Pi and harness import inside src/harness/pi.ts", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => path !== "../src/harness/pi.ts")
      .flatMap(([path, text]) => harnessImports(text).map((module) => `${path}: ${module}`));
    expect(offenders).toEqual([]);
  });
});
