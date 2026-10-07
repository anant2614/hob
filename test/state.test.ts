import { describe, expect, it } from "vitest";
import { INITIAL_APP, reduceApp, type AppState } from "../web/state";

const runningSnapshot = {
  type: "snapshot",
  entries: [],
  run: { inputs: [1] },
  tools: [],
  compactions: [],
  inbox: [],
  agent: {},
  usage: { models: {}, tools: {} }
} as never;

describe("reduceApp", () => {
  it("says connecting until the first open, and reconnecting after a drop", () => {
    const closedEarly = reduceApp(INITIAL_APP, { type: "closed" });
    expect(closedEarly.status).toBe("connecting");
    const open = reduceApp(closedEarly, { type: "open" });
    expect(reduceApp(open, { type: "closed" }).status).toBe("reconnecting");
  });

  it("marks a running answer as resuming when the socket drops", () => {
    let state: AppState = reduceApp(INITIAL_APP, { type: "open" });
    state = reduceApp(state, { type: "server", message: { type: "events", conversation: "1", events: [runningSnapshot] } });
    state = reduceApp(state, { type: "closed" });
    expect(state.view.resuming).toBe(true);
  });

  it("keeps the latest memory list and taint flag the agent sent", () => {
    const item = { key: "tea", text: "Assam", source: "agent", tainted: true, updatedAt: 1 } as const;
    let state = reduceApp(INITIAL_APP, { type: "server", message: { type: "memory", items: [item] } });
    state = reduceApp(state, { type: "server", message: { type: "taint", conversation: "1", tainted: true } });
    expect(state.memory).toEqual([item]);
    expect(state.tainted).toBe(true);
  });

  it("shows an error the agent sent until it is dismissed", () => {
    const state = reduceApp(INITIAL_APP, { type: "server", message: { type: "error", id: "m1", message: "Memory is full" } });
    expect(state.notice).toBe("Memory is full");
    expect(reduceApp(state, { type: "dismiss" }).notice).toBeNull();
  });
});
