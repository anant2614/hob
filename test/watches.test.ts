import { describe, expect, it } from "vitest";
import { Watches } from "../src/agent/watches";
import type { EventStream } from "../src/agent/runtime";
import type { ServerMessage } from "../src/shared/protocol";

type FakeStream = EventStream & {
  emit(events: unknown[]): Promise<void>;
  stopped: boolean;
};

function fakeStream(snapshot: unknown): FakeStream {
  let listener: ((events: readonly unknown[]) => Promise<void>) | undefined;
  const stream: FakeStream = {
    snapshot,
    stopped: false,
    start(next) {
      listener = next;
    },
    async stop() {
      stream.stopped = true;
      listener = undefined;
      return undefined;
    },
    async emit(events) {
      await listener?.(events);
    }
  };
  return stream;
}

function openSocket(): WebSocket {
  const pair = new WebSocketPair();
  const server = pair[1];
  server.accept();
  return server;
}

function harness() {
  const opened: FakeStream[] = [];
  const sent: { socket: WebSocket; message: ServerMessage }[] = [];
  const watches = new Watches(
    async () => {
      const stream = fakeStream({ type: "snapshot", n: opened.length });
      opened.push(stream);
      // Let concurrent callers interleave, as a real open would.
      await new Promise((resolve) => setTimeout(resolve, 5));
      return stream;
    },
    (socket, message) => sent.push({ socket, message })
  );
  return { watches, opened, sent };
}

describe("Watches", () => {
  it("sends the snapshot first, then each batch of events", async () => {
    const { watches, opened, sent } = harness();
    const socket = openSocket();
    await watches.watch(socket, "1");
    await opened[0]?.emit([{ type: "run_start" }]);
    expect(sent.map((entry) => entry.message)).toEqual([
      { type: "events", conversation: "1", events: [{ type: "snapshot", n: 0 }] },
      { type: "events", conversation: "1", events: [{ type: "run_start" }] }
    ]);
  });

  it("replaces a socket's watch on resync and stops the old stream", async () => {
    const { watches, opened } = harness();
    const socket = openSocket();
    await watches.watch(socket, "1");
    await watches.watch(socket, "1");
    expect(opened.map((stream) => stream.stopped)).toEqual([true, false]);
    expect(watches.size).toBe(1);
  });

  it("leaves exactly one live stream when watches for one socket race", async () => {
    const { watches, opened } = harness();
    const socket = openSocket();
    await Promise.all([watches.watch(socket, "1"), watches.watch(socket, "1"), watches.watch(socket, "1")]);
    expect(opened.filter((stream) => !stream.stopped)).toHaveLength(1);
    expect(watches.size).toBe(1);
  });

  it("stops the stream when the socket is unwatched", async () => {
    const { watches, opened } = harness();
    const socket = openSocket();
    await watches.watch(socket, "1");
    await watches.unwatch(socket);
    expect(opened[0]?.stopped).toBe(true);
    expect(watches.size).toBe(0);
  });

  it("drops the watch instead of sending to a closed socket", async () => {
    const { watches, opened, sent } = harness();
    const socket = openSocket();
    await watches.watch(socket, "1");
    socket.close(1000, "bye");
    await opened[0]?.emit([{ type: "run_start" }]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent).toHaveLength(1);
    expect(opened[0]?.stopped).toBe(true);
  });
});
