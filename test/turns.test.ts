import { describe, expect, it } from "vitest";
import type { TranscriptMessage } from "../web/transcript";
import { describeTool, formatCost, groupTurns, readableResult, resultsByCall, shortUrl, type ToolResult } from "../web/turns";

const user = (id: string, text: string): TranscriptMessage => ({ id, role: "user", parts: [{ type: "text", text }], timestamp: 0 });
const hob = (id: string, text: string): TranscriptMessage => ({ id, role: "assistant", parts: [{ type: "text", text }], timestamp: 0 });
const call = (id: string): TranscriptMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "tool-call", id: `call-${id}`, name: "remember", arguments: { key: "tea", text: "Assam" } }],
  timestamp: 0
});
const result = (id: string, callId: string, text: string, error = false): TranscriptMessage => ({
  id,
  role: "tool",
  parts: [{ type: "tool-result", id: callId, name: "remember", content: [{ type: "text", text }], error }],
  timestamp: 0
});
const notice = (id: string, text: string): TranscriptMessage => ({ id, role: "notice", parts: [{ type: "text", text }], timestamp: 0 });

function toolResult(text: string, error = false): ToolResult {
  return { type: "tool-result", id: "c", name: "x", content: [{ type: "text", text }], error };
}

describe("groupTurns", () => {
  it("keeps Hob's tool calls, results and answer together in one turn", () => {
    const turns = groupTurns([
      user("1", "remember tea"),
      call("2"),
      result("3", "call-2", "Saved"),
      hob("4", "Done."),
      notice("5", "New topic"),
      notice("6", ""),
      user("7", "hi")
    ]);
    expect(turns.map((turn) => [turn.kind, turn.id])).toEqual([
      ["you", "1"],
      ["hob", "2"],
      ["notice", "5"],
      ["you", "7"]
    ]);
    const hobTurn = turns[1];
    expect(hobTurn?.kind === "hob" ? hobTurn.messages.map((message) => message.id) : []).toEqual(["2", "3", "4"]);
  });

  it("finds each result by the call it answers", () => {
    expect(resultsByCall([call("2"), result("3", "call-2", "Saved")]).get("call-2")?.content).toEqual([
      { type: "text", text: "Saved" }
    ]);
  });
});

describe("describeTool", () => {
  it.each([
    ["remember", { key: "tea" }, undefined, true, "Saving “tea”", "running"],
    ["remember", { key: "tea" }, toolResult('Saved memory "tea".'), false, "Saved “tea”", "done"],
    ["remember", { key: "!!!" }, toolResult("Keys are…", true), false, "Couldn't save “!!!”", "failed"],
    ["forget", { key: "pet" }, toolResult('Forgot "pet".'), false, "Forgot “pet”", "done"],
    ["forget", { key: "pet" }, toolResult('Nothing was saved under "pet".'), false, "Nothing to forget for “pet”", "done"],
    ["read_page", { url: "https://www.example.com/post/" }, undefined, true, "Reading example.com/post", "running"],
    ["read_page", { url: "https://example.com/" }, toolResult("<untrusted…"), false, "Read example.com", "done"],
    ["read_page", { url: "https://evil.example.net/x?d=1" }, toolResult("Not fetched: …", true), false, "Didn't open evil.example.net/x", "refused"],
    ["read_page", { url: "https://down.example.com/" }, toolResult("Timed out", true), false, "Couldn't read down.example.com", "failed"],
    ["read_page", { url: "https://slow.example.com/a" }, toolResult("Tool read_page was aborted", true), false, "Stopped reading slow.example.com/a", "stopped"],
    ["remember", { key: "tea" }, toolResult("run 1\nTool remember was aborted", true), false, "Stopped saving “tea”", "stopped"],
    ["test_gate", {}, toolResult("Tool test_gate was aborted", true), false, "test_gate stopped", "stopped"]
  ] as const)("%s %j → %s", (name, args, res, running, label, tone) => {
    expect(describeTool(name, args, res, running)).toMatchObject({ label, tone });
  });
});

describe("helpers", () => {
  it("shortens long URLs", () => {
    expect(shortUrl("https://example.com/" + "a".repeat(80))).toHaveLength(48);
    expect(shortUrl("not a url")).toBe("not a url");
  });

  it("strips the untrusted wrapper for display", () => {
    expect(readableResult('<untrusted source="https://x.example">\nHello\n</untrusted>')).toBe("Hello");
  });

  it.each([
    [0, "$0.00"],
    [0.004, "under $0.01"],
    [1.234, "$1.23"]
  ])("formats %s as %s", (cost, text) => {
    expect(formatCost(cost)).toBe(text);
  });
});
