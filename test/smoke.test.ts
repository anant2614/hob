import { describe, expect, it } from "vitest";

describe("the test pool", () => {
  it("runs inside workerd", () => {
    expect(typeof WebSocketPair).toBe("function");
  });
});
