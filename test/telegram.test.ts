import { runInDurableObject, SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  chunkText,
  handleTelegramWebhook,
  parseUpdate,
  sendTelegramMessage,
  TELEGRAM_MAX_CHARS,
  type TelegramMessage
} from "../src/channels/telegram";
import { GATE_RELEASE, TELEGRAM_SENT, type SentTelegram } from "./worker";

const SECRET = "test-telegram-secret";
const OWNER = 4242;
const OWNER_AGENT = "u:usr_test";

let nextUpdate = 5000;

function update(text: string, from = OWNER, updateId = nextUpdate++) {
  return { update_id: updateId, message: { message_id: updateId, from: { id: from }, chat: { id: 777 }, text } };
}

function postUpdate(body: unknown, secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  return SELF.fetch("https://agent.example.com/hooks/telegram", { method: "POST", headers, body: JSON.stringify(body) });
}

function inOwnerAgent<T>(fn: (instance: unknown, state: DurableObjectState) => T | Promise<T>): Promise<T> {
  return runInDurableObject(env.PiAgent.getByName(OWNER_AGENT), fn);
}

const sent = () => inOwnerAgent((_instance, state) => state.storage.kv.get<SentTelegram[]>(TELEGRAM_SENT) ?? []);

async function waitForReply(text: string): Promise<SentTelegram[]> {
  for (let i = 0; i < 300; i++) {
    const replies = (await sent()).filter((message) => message.text === text);
    if (replies.length > 0) return replies;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no Telegram reply ${JSON.stringify(text)}; sent: ${JSON.stringify(await sent())}`);
}

describe("parseUpdate", () => {
  it("reads a text message", () => {
    expect(parseUpdate(update("hi", OWNER, 1))).toEqual({ updateId: 1, chatId: "777", fromId: "4242", text: "hi" });
  });

  it("ignores updates that are not a new text message", () => {
    expect(parseUpdate({ update_id: 2, edited_message: { from: { id: OWNER }, chat: { id: 1 }, text: "x" } })).toBeNull();
    expect(parseUpdate({ update_id: 3, message: { from: { id: OWNER }, chat: { id: 1 } } })).toBeNull();
    expect(parseUpdate({ update_id: 4, message: { from: { id: OWNER }, chat: { id: 1 }, text: "  " } })).toBeNull();
    expect(parseUpdate("not an update")).toBeNull();
  });
});

describe("chunkText", () => {
  it("splits text into pieces Telegram accepts", () => {
    const text = "a".repeat(TELEGRAM_MAX_CHARS * 2 + 10);
    expect(chunkText(text).map((piece) => piece.length)).toEqual([TELEGRAM_MAX_CHARS, TELEGRAM_MAX_CHARS, 10]);
  });

  it("sends an empty answer as a visible note", () => {
    expect(chunkText("")).toEqual(["(The answer had no text.)"]);
  });
});

describe("sendTelegramMessage", () => {
  it("posts each piece to the bot's sendMessage method", async () => {
    const calls: { url: string; body: { chat_id: string; text: string } }[] = [];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }) as typeof fetch;
    await sendTelegramMessage(fake, "bot-token", "777", "b".repeat(TELEGRAM_MAX_CHARS + 1));
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.telegram.org/botbot-token/sendMessage",
      "https://api.telegram.org/botbot-token/sendMessage"
    ]);
    expect(calls.map((call) => [call.body.chat_id, call.body.text.length])).toEqual([
      ["777", TELEGRAM_MAX_CHARS],
      ["777", 1]
    ]);
  });

  it("fails when Telegram refuses, without echoing the token", async () => {
    const refuse = (async () => new Response("Bad Request: chat not found", { status: 400 })) as typeof fetch;
    const failure = sendTelegramMessage(refuse, "secret-token", "1", "hi");
    await expect(failure).rejects.toThrow("Telegram refused the message (400)");
    await expect(failure).rejects.not.toThrow("secret-token");
  });
});

describe("handleTelegramWebhook", () => {
  const configured = { TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_OWNER_ID: String(OWNER) };
  const request = (body: unknown, secret = SECRET) =>
    new Request("https://agent.example.com/hooks/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify(body)
    });

  it("is switched off until a webhook secret and an owner are configured", async () => {
    const delivered: TelegramMessage[] = [];
    const deliver = async (message: TelegramMessage) => void delivered.push(message);
    expect((await handleTelegramWebhook(request(update("hi")), { TELEGRAM_OWNER_ID: "4242" }, deliver)).status).toBe(404);
    expect((await handleTelegramWebhook(request(update("hi")), { TELEGRAM_WEBHOOK_SECRET: SECRET }, deliver)).status).toBe(404);
    expect(delivered).toEqual([]);
  });

  it("accepts only POST", async () => {
    const response = await handleTelegramWebhook(new Request("https://agent.example.com/hooks/telegram"), configured, async () => {});
    expect(response.status).toBe(405);
  });

  it("hands the owner's message on and answers Telegram at once", async () => {
    const delivered: TelegramMessage[] = [];
    const response = await handleTelegramWebhook(request(update("hello", OWNER, 9)), configured, async (message) => {
      delivered.push(message);
    });
    expect(response.status).toBe(200);
    expect(delivered).toEqual([{ updateId: 9, chatId: "777", fromId: "4242", text: "hello" }]);
  });
});

describe("the Telegram webhook on the edge", () => {
  it("refuses a request without the right secret", async () => {
    expect((await postUpdate(update("hi"), null)).status).toBe(401);
    expect((await postUpdate(update("hi"), "wrong")).status).toBe(401);
  });

  it("ignores messages from anyone but the owner", async () => {
    const body = update("let me in", 999);
    expect((await postUpdate(body)).status).toBe(200);
    const row = await inOwnerAgent((instance) =>
      (instance as { store: { outbox: { get(op: string): unknown } } }).store.outbox.get(`tg:${body.update_id}`)
    );
    expect(row).toBeUndefined();
  });

  it("answers the owner's message in the same chat", async () => {
    expect((await postUpdate(update("hello from my phone"))).status).toBe(200);
    const [reply] = await waitForReply("echo: hello from my phone");
    expect(reply).toMatchObject({ chatId: "777", url: "https://api.telegram.org/bottest-bot-token/sendMessage" });
  });

  it("sends one reply when Telegram delivers the same update twice", async () => {
    const body = update("only once please");
    expect((await postUpdate(body)).status).toBe(200);
    expect((await postUpdate(body)).status).toBe(200);
    await waitForReply("echo: only once please");
    // Give a second, duplicate delivery job time to run if one had been scheduled.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect((await sent()).filter((message) => message.text === "echo: only once please")).toHaveLength(1);
  });

  it("treats sites named on Telegram as named by the owner", async () => {
    await postUpdate(update("have a look at https://news.example.org/today"));
    await waitForReply("echo: have a look at https://news.example.org/today");
    const named = await inOwnerAgent((instance) =>
      (instance as { store: { conversations: { hasOwnerHost(c: string, h: string): boolean } } }).store.conversations.hasOwnerHost(
        "1",
        "news.example.org"
      )
    );
    expect(named).toBe(true);
  });

  it("waits for a run that is still going, then replies once it ends", async () => {
    await inOwnerAgent((_instance, state) => state.storage.kv.put(GATE_RELEASE, false));
    await postUpdate(update("slow"));
    // The first checks find the run still going and must not send anything.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect((await sent()).some((message) => message.text.startsWith("tool said: released"))).toBe(false);
    await inOwnerAgent((_instance, state) => state.storage.kv.put(GATE_RELEASE, true));
    for (let i = 0; i < 300; i++) {
      if ((await sent()).some((message) => message.text.startsWith("tool said: released"))) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no reply after the run ended; sent: ${JSON.stringify(await sent())}`);
  });
});
