import { describe, expect, it } from "vitest";
import { toPiTool } from "../src/harness/pi";
import { Policy } from "../src/tools/policy";
import type { Effect, ToolSpec } from "../src/tools/spec";

const policy = new Policy({
  conversations: { isTainted: () => false, taint: () => undefined, hasOwnerHost: () => false }
});

function spec(effect: Effect, sequential?: boolean): ToolSpec {
  return {
    name: `t_${effect}`,
    description: "d",
    inputSchema: { type: "object", properties: { a: { type: "string" } } },
    effect,
    ...(sequential === undefined ? {} : { sequential }),
    execute: async () => ({ content: [{ type: "text", text: "ok" }] })
  };
}

describe("toPiTool", () => {
  it.each([
    ["read", undefined, "safe", "parallel"],
    ["idempotent-write", undefined, "safe", "parallel"],
    ["read", true, "safe", "sequential"],
    ["side-effect", undefined, "unsafe", "sequential"]
  ] as const)("%s (sequential: %s) replays %s and runs %s", (effect, sequential, replay, mode) => {
    const tool = toPiTool(spec(effect, sequential), policy);
    expect(tool.replay).toBe(replay);
    expect(tool.executionMode).toBe(mode);
  });

  it("offers the model the spec's name, description and JSON Schema", () => {
    const tool = toPiTool(spec("read"), policy);
    expect({ name: tool.name, description: tool.description, parameters: tool.parameters }).toEqual({
      name: "t_read",
      description: "d",
      parameters: { type: "object", properties: { a: { type: "string" } } }
    });
  });
});
