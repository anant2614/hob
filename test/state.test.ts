import { describe, expect, it } from "vitest";
import { INITIAL_APP, needsReload, reduceApp, statusText, type AppState } from "../web/state";

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

  it("dismisses a failed run's error too", () => {
    const failed = { ...INITIAL_APP, view: { ...INITIAL_APP.view, error: "The model call failed: overloaded" } };
    expect(reduceApp(failed, { type: "dismiss" }).view.error).toBeNull();
  });

  it("ignores frames it does not know, as from a newer server", () => {
    const future = { type: "server", message: { type: "from_the_future", data: 1 } } as never;
    expect(reduceApp(INITIAL_APP, future)).toBe(INITIAL_APP);
    expect(reduceApp(INITIAL_APP, { type: "server", message: null } as never)).toBe(INITIAL_APP);
  });

  it("counts failed reconnects until the socket opens again", () => {
    let state = reduceApp(INITIAL_APP, { type: "open" });
    for (let i = 0; i < 3; i++) state = reduceApp(state, { type: "closed" });
    expect(state.failures).toBe(3);
    expect(reduceApp(state, { type: "open" }).failures).toBe(0);
  });
});

describe("statusText", () => {
  it("names the model when ready, and the work while running", () => {
    let state = reduceApp(INITIAL_APP, { type: "open" });
    state = reduceApp(state, { type: "server", message: { type: "hello", protocol: "pi-events/1", conversation: "1", tools: [], model: "cloudflare/anthropic/claude-opus-5-5" } });
    expect(statusText(state)).toBe("Ready. claude-opus-5-5");
    state = reduceApp(state, { type: "server", message: { type: "events", conversation: "1", events: [runningSnapshot] } });
    expect(statusText(state)).toBe("Working…");
  });

  it("suggests a reload once reconnecting keeps failing, as when the sign-in has expired", () => {
    let state = reduceApp(reduceApp(INITIAL_APP, { type: "open" }), { type: "closed" });
    expect(statusText(state)).toBe("Reconnecting…");
    expect(needsReload(state)).toBe(false);
    state = reduceApp(reduceApp(state, { type: "closed" }), { type: "closed" });
    expect(statusText(state)).toBe("Can't reach Hob. If you were signed out, reload to sign in again.");
    expect(needsReload(state)).toBe(true);
    expect(needsReload(reduceApp(state, { type: "open" }))).toBe(false);
  });
});
