import { abortAllDurableObjects, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { connectAgent, eventTypes, lastOf, transcript, type Client } from "./ws";
import { GATE_RELEASE, GATE_RUNS } from "./worker";

function kv<T>(name: string, key: string): Promise<T | undefined> {
  return runInDurableObject(env.PiAgent.getByName(name), (_instance, state) => state.storage.kv.get<T>(key));
}

async function waitForGateRuns(name: string, runs: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (((await kv<number>(name, GATE_RUNS)) ?? 0) >= runs) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`gate never reached ${runs} runs`);
}

function memoryKeys(client: Client): string[] {
  return lastOf(client.frames, "memory")?.items.map((item) => item.key) ?? [];
}

async function settle(client: Client, text: string): Promise<void> {
  await client.until(() => transcript(client.frames).includes(text), JSON.stringify(text));
  await client.until(() => eventTypes(client.frames).at(-1) !== undefined && !isRunning(client), "the run to end");
}

function isRunning(client: Client): boolean {
  let running = false;
  for (const type of eventTypes(client.frames)) {
    if (type === "run_start") running = true;
    if (type === "run_end") running = false;
  }
  return running;
}

describe("a connected client", () => {
  it("gets a hello, the memory, the taint flag and a snapshot, in that order", async () => {
    const client = await connectAgent();
    await client.until(() => client.frames.some((frame) => frame.type === "events"), "the snapshot");
    expect(client.frames.map((frame) => frame.type)).toEqual(["hello", "memory", "taint", "events"]);
    expect(client.frames[0]).toMatchObject({
      type: "hello",
      protocol: "pi-events/1",
      conversation: "1",
      tools: expect.arrayContaining([
        expect.objectContaining({ name: "remember" }),
        expect.objectContaining({ name: "forget" }),
        expect.objectContaining({ name: "read_page" })
      ])
    });
    expect(client.frames[1]).toEqual({ type: "memory", items: [] });
    expect(client.frames[2]).toEqual({ type: "taint", conversation: "1", tainted: false });
    client.socket.close();
  });

  it("refuses any conversation but the root one", async () => {
    const response = await env.PiAgent.getByName(crypto.randomUUID()).fetch(
      new Request("http://localhost/chat?session=2", { headers: { Upgrade: "websocket" } })
    );
    const socket = response.webSocket as WebSocket;
    socket.accept();
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    expect(await closed).toBe(4404);
  });

  it("answers a submitted message and acknowledges it once", async () => {
    const client = await connectAgent();
    client.send({ type: "submit", id: "c1", input: "hello there", operationId: "op-1" });
    await settle(client, "echo: hello there");
    client.send({ type: "submit", id: "c2", input: "hello there", operationId: "op-1" });
    await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === "c2"), "c2");
    const results = client.frames.filter((frame) => frame.type === "result");
    expect(results).toEqual([
      { type: "result", id: "c1", result: { operationId: "op-1", conversation: "1", accepted: true } },
      { type: "result", id: "c2", result: { operationId: "op-1", conversation: "1", accepted: false } }
    ]);
    client.socket.close();
  });

  it("reports a malformed message without closing the socket", async () => {
    const client = await connectAgent();
    client.socket.send("{not json");
    await client.until(() => client.frames.some((frame) => frame.type === "error"), "an error frame");
    client.send({ type: "submit", input: "still here" });
    await settle(client, "echo: still here");
    client.socket.close();
  });
});

describe("memory", () => {
  it("is saved by the remember tool and pushed to the client", async () => {
    const client = await connectAgent();
    client.send({ type: "submit", input: "remember coffee: Flat white with oat milk" });
    await client.until(() => memoryKeys(client).includes("coffee"), "the coffee memory");
    await settle(client, 'tool said: Saved memory "coffee".');
    expect(lastOf(client.frames, "memory")?.items).toEqual([
      expect.objectContaining({ key: "coffee", text: "Flat white with oat milk", source: "agent", tainted: false })
    ]);
    client.socket.close();
  });

  it("can be edited and deleted by the owner from the UI", async () => {
    const client = await connectAgent();
    client.send({ type: "memory_set", id: "m1", key: "City", text: "Pune" });
    await client.until(() => memoryKeys(client).includes("city"), "the city memory");
    expect(lastOf(client.frames, "memory")?.items[0]).toMatchObject({ key: "city", source: "owner" });
    client.send({ type: "memory_set", id: "m2", key: "!!!", text: "x" });
    await client.until(() => client.frames.some((frame) => frame.type === "error" && frame.id === "m2"), "m2 error");
    client.send({ type: "memory_delete", id: "m3", key: "city" });
    await client.until(() => lastOf(client.frames, "memory")?.items.length === 0, "the deletion");
    client.socket.close();
  });

  it("and the transcript survive the object being evicted", async () => {
    const first = await connectAgent();
    first.send({ type: "submit", input: "remember pet: A cat called Miso" });
    await settle(first, 'tool said: Saved memory "pet".');
    first.socket.close();

    await evictDurableObject(env.PiAgent.getByName(first.name), { webSockets: "close" });

    const second = await connectAgent(first.name);
    await second.until(() => second.frames.some((frame) => frame.type === "events"), "the snapshot");
    expect(lastOf(second.frames, "memory")?.items.map((item) => item.key)).toEqual(["pet"]);
    expect(transcript(second.frames)).toContain('tool said: Saved memory "pet".');
    second.socket.close();
  });
});

describe("reading the web", () => {
  it("labels the page as untrusted, taints the conversation, and reset clears it", async () => {
    const client = await connectAgent();
    client.send({ type: "submit", input: "read https://example.com/post" });
    await client.until(() => lastOf(client.frames, "taint")?.tainted === true, "the taint flag");
    await client.until(() => transcript(client.frames).some((text) => text.startsWith("tool said:")), "the answer");
    expect(transcript(client.frames, "toolResult")[0]).toMatch(/^<untrusted source="https:\/\/example\.com\/post">/);

    client.send({ type: "reset", id: "r1" });
    await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === "r1"), "r1");
    expect(lastOf(client.frames, "taint")?.tainted).toBe(false);
    client.socket.close();
  });

  it("refuses to follow a page to a host the owner never named", async () => {
    const client = await connectAgent();
    client.send({ type: "submit", input: "read https://example.com/post" });
    await client.until(() => lastOf(client.frames, "taint")?.tainted === true, "the taint flag");
    await client.until(() => !isRunning(client) && transcript(client.frames).length > 0, "the first run");
    client.send({ type: "submit", input: "follow" });
    await client.until(() => transcript(client.frames, "toolResult").length === 2, "the refused read");
    const refused = transcript(client.frames, "toolResult")[1];
    expect(refused).toContain("Not fetched");
    expect(refused).toContain("evil.example.net");
    expect(refused).not.toContain("<untrusted");
    client.socket.close();
  });

  it("still reads a site the owner names after the conversation is tainted", async () => {
    const client = await connectAgent();
    client.send({ type: "submit", input: "read https://example.com/post" });
    await client.until(() => lastOf(client.frames, "taint")?.tainted === true, "the taint flag");
    await client.until(() => !isRunning(client) && transcript(client.frames).length > 0, "the first run");
    client.send({ type: "submit", input: "read https://docs.example.org/guide" });
    await client.until(() => transcript(client.frames, "toolResult").length === 2, "the second read");
    expect(transcript(client.frames, "toolResult")[1]).toMatch(/^<untrusted source="https:\/\/docs\.example\.org\/guide">/);
    client.socket.close();
  });
});

describe("stopping and recovering", () => {
  it("stops a running tool promptly when the owner aborts", async () => {
    const client = await connectAgent();
    client.send({ type: "submit", input: "slow" });
    await waitForGateRuns(client.name, 1);
    client.send({ type: "abort", id: "a1" });
    await client.until(() => client.frames.some((frame) => frame.type === "result" && frame.id === "a1"), "a1");
    await client.until(() => !isRunning(client), "the run to end");
    client.socket.close();
  });

  it("finishes a run after the object crashes mid-tool", async () => {
    const client = await connectAgent();
    const stub = env.PiAgent.getByName(client.name);
    client.send({ type: "submit", input: "slow" });
    await waitForGateRuns(client.name, 1);

    // A deploy or an out-of-memory kill: the isolate dies with the tool mid-call.
    await abortAllDurableObjects();
    await runInDurableObject(stub, (_instance, state) => state.storage.kv.put(GATE_RELEASE, true));
    // The harness's wake job is still due; its alarm restarts Pi, which reruns the
    // replay-safe tool from its checkpoint.
    for (let i = 0; i < 20 && ((await kv<number>(client.name, GATE_RUNS)) ?? 0) < 2; i++) {
      await runDurableObjectAlarm(stub);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const after = await connectAgent(client.name);
    await after.until(
      () => transcript(after.frames).includes("tool said: released after 2 runs"),
      "the resumed answer"
    );
    after.socket.close();
  });
});
