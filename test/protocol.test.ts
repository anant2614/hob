import { describe, expect, it } from "vitest";
import { MAX_INPUT_CHARS, parseClientMessage } from "../src/shared/protocol";

describe("parseClientMessage", () => {
  it.each([
    [{ type: "submit", id: "c1", input: "hi", operationId: "op-1", whenBusy: "steer" }],
    [{ type: "submit", input: "hi" }],
    [{ type: "abort", id: "c2" }],
    [{ type: "reset" }],
    [{ type: "reset", handoff: "We were planning a trip." }],
    [{ type: "resync" }],
    [{ type: "memory_set", key: "city", text: "Pune" }],
    [{ type: "memory_delete", id: "c3", key: "city" }]
  ])("accepts %j", (message) => {
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each([
    ["not json", "{"],
    ["a non-object", JSON.stringify(["submit"])],
    ["an unknown type", JSON.stringify({ type: "rpc", method: "destroy" })],
    ["a submit without input", JSON.stringify({ type: "submit" })],
    ["a blank submit", JSON.stringify({ type: "submit", input: "   " })],
    ["an oversized submit", JSON.stringify({ type: "submit", input: "x".repeat(MAX_INPUT_CHARS + 1) })],
    ["an unknown whenBusy", JSON.stringify({ type: "submit", input: "hi", whenBusy: "now" })],
    ["a non-string id", JSON.stringify({ type: "abort", id: 7 })],
    ["memory_set without text", JSON.stringify({ type: "memory_set", key: "a" })],
    ["memory_delete without key", JSON.stringify({ type: "memory_delete" })]
  ])("rejects %s", (_name, raw) => {
    expect(parseClientMessage(raw)).toEqual({ error: expect.any(String) });
  });

  it("rejects binary frames", () => {
    expect(parseClientMessage(new ArrayBuffer(4))).toEqual({ error: expect.any(String) });
  });
});
