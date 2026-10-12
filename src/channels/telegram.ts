// The Telegram channel's edge half: verify the webhook, read the update, send
// replies. Harness-neutral, so it survives a harness swap unchanged. The agent
// owns the durable half (the outbox and the scheduled delivery).

export const TELEGRAM_PATH = "/hooks/telegram";
/** Telegram's limit for one message's text. */
export const TELEGRAM_MAX_CHARS = 4096;
const EMPTY_ANSWER = "(The answer had no text.)";

/** A new text message, from the verified webhook payload only. */
export type TelegramMessage = {
  readonly updateId: number;
  readonly chatId: string;
  readonly fromId: string;
  readonly text: string;
};

export type TelegramEnv = {
  /** The secret_token given to setWebhook; Telegram sends it back on every update. Unset: the channel is off. */
  readonly TELEGRAM_WEBHOOK_SECRET?: string;
  /** The owner's numeric Telegram user id. Every other sender is ignored. Unset: the channel is off. */
  readonly TELEGRAM_OWNER_ID?: string;
};

type RawUpdate = {
  update_id?: unknown;
  message?: { chat?: { id?: unknown }; from?: { id?: unknown }; text?: unknown };
};

/** The new text message in an update, or null for anything else (edits, joins, stickers, callbacks). */
export function parseUpdate(body: unknown): TelegramMessage | null {
  if (typeof body !== "object" || body === null) return null;
  const { update_id: updateId, message } = body as RawUpdate;
  if (typeof updateId !== "number" || message === undefined) return null;
  const { text, chat, from } = message;
  if (typeof text !== "string" || text.trim() === "") return null;
  if (typeof chat?.id !== "number" || typeof from?.id !== "number") return null;
  return { updateId, chatId: String(chat.id), fromId: String(from.id), text };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The webhook. Telegram can't pass Access, so the edge calls this before
 * authenticating, and the hostname's Access application needs a Bypass policy
 * for exactly this path. The secret header proves the request came from
 * Telegram; the sender's id, from the payload, proves it came from the owner.
 */
export async function handleTelegramWebhook(
  request: Request,
  env: TelegramEnv,
  deliver: (message: TelegramMessage) => Promise<void>
): Promise<Response> {
  const secret = env.TELEGRAM_WEBHOOK_SECRET ?? "";
  const owner = env.TELEGRAM_OWNER_ID ?? "";
  if (secret === "" || owner === "") return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  if (!safeEqual(request.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const message = parseUpdate(body);
  if (message === null) return new Response("ok");
  if (message.fromId !== owner) {
    console.log(JSON.stringify({ event: "telegram_ignored", from: message.fromId }));
    return new Response("ok");
  }
  await deliver(message);
  return new Response("ok");
}

/** Split text into pieces Telegram accepts. An empty answer becomes a visible note. */
export function chunkText(text: string, size = TELEGRAM_MAX_CHARS): string[] {
  if (text === "") return [EMPTY_ANSWER];
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += size) pieces.push(text.slice(start, start + size));
  return pieces;
}

/** Send text as plain messages. Errors never include the URL, which carries the bot token. */
export async function sendTelegramMessage(fetcher: typeof fetch, token: string, chatId: string, text: string): Promise<void> {
  for (const piece of chunkText(text)) {
    const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: piece })
    });
    if (!response.ok) throw new Error(`Telegram refused the message (${response.status})`);
  }
}
