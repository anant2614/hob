import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect } from "vitest";
import type { ClientMessage, ServerMessage } from "../src/shared/protocol";

export type Frame = ServerMessage<AgentEvent>;

export type Client = {
  readonly socket: WebSocket;
  readonly frames: Frame[];
  send(message: ClientMessage): void;
  /** Wait until `check` holds, re-checking on every frame. */
  until(check: () => boolean, what?: string): Promise<void>;
};

export function follow(socket: WebSocket): Client {
  const frames: Frame[] = [];
  const waiters: (() => void)[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    frames.push(JSON.parse(event.data) as Frame);
    for (const wake of waiters.splice(0)) wake();
  });
  return {
    socket,
    frames,
    send: (message) => socket.send(JSON.stringify(message)),
    async until(check, what = "condition") {
      const deadline = Date.now() + 15_000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 25);
        });
      }
    }
  };
}

function upgrade(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { Upgrade: "websocket", ...headers } });
}

/** Connect straight to a fresh, uniquely named agent object, bypassing the edge Worker. */
export async function connectAgent(name: string = crypto.randomUUID()): Promise<Client & { name: string }> {
  const stub = env.PiAgent.getByName(name);
  const response = await stub.fetch(upgrade("http://localhost/chat?session=1"));
  expect(response.status).toBe(101);
  const socket = response.webSocket as WebSocket;
  socket.accept();
  return { ...follow(socket), name };
}

/** Connect through the edge Worker, as the browser does. */
export async function fetchChat(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(upgrade(url, headers));
}

function texts(entry: EntryRecord, role: "assistant" | "toolResult"): string[] {
  const message = entry.model?.[0];
  if (message?.role !== role) return [];
  const content = message.content;
  if (typeof content === "string") return [content];
  return [content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("")];
}

/** Messages of one role in the transcript a client sees: the latest snapshot plus later appends. */
export function transcript(frames: readonly Frame[], role: "assistant" | "toolResult" = "assistant"): string[] {
  let out: string[] = [];
  for (const frame of frames) {
    if (frame.type !== "events") continue;
    for (const event of frame.events) {
      if (event.type === "snapshot") out = event.entries.flatMap((entry) => texts(entry, role));
      else if (event.type === "message_end" || event.type === "entry_appended") out.push(...texts(event.entry, role));
    }
  }
  return out;
}

export function eventTypes(frames: readonly Frame[]): string[] {
  return frames.flatMap((frame) => (frame.type === "events" ? frame.events.map((event) => event.type) : []));
}

export function lastOf<T extends Frame["type"]>(frames: readonly Frame[], type: T): Extract<Frame, { type: T }> | undefined {
  return frames.filter((frame): frame is Extract<Frame, { type: T }> => frame.type === type).at(-1);
}
