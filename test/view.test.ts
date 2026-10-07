import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { EMPTY_VIEW, reduceEvents, reduceView, type HobView } from "../web/view";
import { connectAgent, transcript } from "./ws";

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};

function usage(total: number, input = 100, output = 10): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total }
  };
}

function userEntry(id: number, text: string): EntryRecord {
  return {
    id,
    kind: "pi.user",
    model: [{ role: "user", content: text, timestamp: id }]
  } as unknown as EntryRecord;
}

function snapshot(overrides: Partial<Extract<AgentEvent, { type: "snapshot" }>> = {}): AgentEvent {
  return {
    type: "snapshot",
    entries: [],
    tools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: {}, tools: {} },
    ...overrides
  } as AgentEvent;
}

describe("reduceView", () => {
  it("replaces everything on a snapshot, so a reconnect never duplicates messages", () => {
    const first = reduceEvents(EMPTY_VIEW, [snapshot({ entries: [userEntry(1, "hi")] })]);
    const again = reduceEvents(first, [snapshot({ entries: [userEntry(1, "hi"), userEntry(2, "there")] })]);
    expect(again.messages.map((message) => message.id)).toEqual(["1", "2"]);
  });

  it("starts a fresh view when a reset entry arrives, as a reload would show", () => {
    const before = reduceEvents(EMPTY_VIEW, [snapshot({ entries: [userEntry(1, "old topic")] })]);
    const reset = { id: 2, kind: "pi.reset" } as unknown as EntryRecord;
    const after = reduceView(before, { type: "entry_appended", entry: reset } as never);
    expect(after.messages.map((message) => [message.role, message.parts])).toEqual([
      ["notice", [{ type: "text", text: "New topic" }]]
    ]);
  });

  it("adds up the conversation's spend across models and tools", () => {
    const view = reduceEvents(EMPTY_VIEW, [
      snapshot({
        usage: {
          models: { "cloudflare/anthropic/claude-opus-5-5": usage(0.25) },
          tools: { read_page: usage(0.01, 0, 0) }
        } as never
      })
    ]);
    expect(view.usage.cost).toBeCloseTo(0.26);
    expect(view.usage.tokens).toBe(110);
    const later = reduceView(view, {
      type: "usage_changed",
      usage: { models: { "cloudflare/anthropic/claude-opus-5-5": usage(0.5, 300, 30) }, tools: {} }
    } as never);
    expect(later.usage.cost).toBeCloseTo(0.5);
    expect(later.usage.tokens).toBe(330);
  });

  it("tracks compaction from the snapshot and from start and end events", () => {
    const running = reduceEvents(EMPTY_VIEW, [
      snapshot({ compactions: [{ taskId: 7, reason: "threshold", blocking: false, attempt: 1 }] as never })
    ]);
    expect(running.compacting).toBe(true);
    const done = reduceView(running, { type: "compaction_end", taskId: 7, reason: "threshold" } as never);
    expect(done.compacting).toBe(false);
    const again = reduceView(done, { type: "compaction_start", taskId: 9, reason: "manual", blocking: true } as never);
    expect(again.compacting).toBe(true);
  });

  it("shows why an input went unanswered, but not when the owner stopped it", () => {
    const failed = reduceView(EMPTY_VIEW, {
      type: "submission",
      record: { status: "unanswered", reason: "no_model" }
    } as never);
    expect(failed.error).toMatch(/model/i);
    const gateway = reduceView(EMPTY_VIEW, {
      type: "submission",
      record: { status: "unanswered", reason: "model_error", detail: "401 Unauthorized: spend limit reached" }
    } as never);
    expect(gateway.error).toContain("401 Unauthorized: spend limit reached");
    const stopped = reduceView(EMPTY_VIEW, {
      type: "submission",
      record: { status: "unanswered", reason: "aborted" }
    } as never);
    expect(stopped.error).toBeNull();
    expect(reduceView(failed, { type: "run_start", inputs: [] } as never).error).toBeNull();
  });
});

describe("resuming after a dropped connection", () => {
  const runningSnapshot = snapshot({ run: { inputs: [1 as never] } });

  it("marks a run that was going when the socket dropped, until it visibly moves", () => {
    const live = reduceEvents(EMPTY_VIEW, [runningSnapshot]);
    const dropped = reduceView(live, { type: "disconnected" });
    expect(dropped.resuming).toBe(true);
    const reconnected = reduceView(dropped, runningSnapshot);
    expect(reconnected.resuming).toBe(true);
    const moving = reduceView(reconnected, { type: "message_update", usage: usage(0), changes: [] } as never);
    expect(moving.resuming).toBe(false);
  });

  it("clears once a snapshot shows the run already finished", () => {
    const dropped = reduceView(reduceEvents(EMPTY_VIEW, [runningSnapshot]), { type: "disconnected" });
    expect(reduceView(dropped, snapshot()).resuming).toBe(false);
  });

  it("is not set when the socket drops while idle", () => {
    expect(reduceView(EMPTY_VIEW, { type: "disconnected" }).resuming).toBe(false);
  });
});

describe("a real run", () => {
  it("folds to the same messages whether followed live or loaded later", async () => {
    const live = await connectAgent();
    live.send({ type: "submit", input: "remember tea: Assam, no sugar" });
    await live.until(() => transcript(live.frames).includes('tool said: Saved memory "tea".'), "the answer");
    await live.until(
      () => live.frames.some((frame) => frame.type === "events" && frame.events.some((event) => event.type === "run_end")),
      "run_end"
    );
    const folded = fold(live.frames);

    const late = await connectAgent(live.name);
    await late.until(() => late.frames.some((frame) => frame.type === "events"), "the snapshot");
    const fresh = fold(late.frames);

    expect(fresh.messages).toEqual(folded.messages);
    expect(fresh.running).toBe(false);
    expect(folded.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    live.socket.close();
    late.socket.close();
  });
});

function fold(frames: { type: string; events?: readonly AgentEvent[] }[]): HobView {
  return frames.reduce(
    (view, frame) => (frame.type === "events" && frame.events ? reduceEvents(view, frame.events) : view),
    EMPTY_VIEW
  );
}
