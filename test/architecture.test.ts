import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true
});

const HARNESS_IMPORT = /from\s+["'](@earendil-works\/[^"']+|agents\/harness[^"']*|agents\/models[^"']*)["']/g;

describe("the harness boundary", () => {
  it("finds the source files", () => {
    expect(Object.keys(sources)).toContain("../src/harness/pi.ts");
    expect(Object.keys(sources).length).toBeGreaterThan(5);
  });

  it("keeps every Pi and harness import inside src/harness/pi.ts", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => path !== "../src/harness/pi.ts")
      .flatMap(([path, text]) => [...text.matchAll(HARNESS_IMPORT)].map((match) => `${path}: ${match[1]}`));
    expect(offenders).toEqual([]);
  });
});
