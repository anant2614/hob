import { describe, expect, it } from "vitest";
import { Outbox, Requests } from "../web/outbox";

const submit = (id: string) => ({ type: "submit", id, operationId: `op-${id}`, input: id }) as const;

describe("Outbox", () => {
  it("keeps each submission until the agent answers it", () => {
    const outbox = new Outbox();
    outbox.add(submit("a"), 0);
    outbox.add(submit("b"), 10);
    expect(outbox.settle("a")).toBe(true);
    expect(outbox.settle("a")).toBe(false);
    expect(outbox.resend(20)).toEqual([submit("b")]);
  });

  it("resends the unanswered ones oldest first, with the same ids, and restarts their clocks", () => {
    const outbox = new Outbox();
    outbox.add(submit("a"), 0);
    outbox.add(submit("b"), 5);
    expect(outbox.overdue(10_000, 9_000)).toBe(true);
    expect(outbox.resend(10_000)).toEqual([submit("a"), submit("b")]);
    expect(outbox.overdue(10_000, 9_000)).toBe(false);
    expect(outbox.overdue(19_001, 9_000)).toBe(true);
  });

  it("is never overdue when empty", () => {
    expect(new Outbox().overdue(Number.MAX_SAFE_INTEGER, 1)).toBe(false);
  });
});

describe("Requests", () => {
  it("resolves with the result frame for its id", async () => {
    const requests = new Requests();
    const answer = requests.wait("m1");
    expect(requests.settle({ type: "result", id: "other", result: 1 })).toBe(false);
    expect(requests.settle({ type: "result", id: "m1", result: { key: "tea" } })).toBe(true);
    await expect(answer).resolves.toEqual({ key: "tea" });
  });

  it("rejects with the agent's error message", async () => {
    const requests = new Requests();
    const answer = requests.wait("m1");
    expect(requests.settle({ type: "error", id: "m1", message: "Memory is full" })).toBe(true);
    await expect(answer).rejects.toThrow("Memory is full");
  });

  it("fails everything still waiting when the socket drops", async () => {
    const requests = new Requests();
    const first = requests.wait("m1");
    const second = requests.wait("m2");
    requests.failAll("Hob went offline");
    await expect(first).rejects.toThrow("Hob went offline");
    await expect(second).rejects.toThrow("Hob went offline");
    expect(requests.settle({ type: "result", id: "m1", result: null })).toBe(false);
  });

  it("ignores frames that answer nothing", () => {
    const requests = new Requests();
    expect(requests.settle({ type: "error", message: "no id" })).toBe(false);
    expect(requests.settle({ type: "taint", conversation: "1", tainted: true })).toBe(false);
  });
});
