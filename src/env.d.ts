// Secrets for optional channels. They are set with `wrangler secret put` only
// when the channel is used, so they are not in `secrets.required` and wrangler
// types doesn't generate them. Unset means the channel is off.
declare global {
  interface Env {
    /** The bot's token from @BotFather. */
    TELEGRAM_BOT_TOKEN?: string;
    /** The secret_token passed to setWebhook; Telegram sends it back with every update. */
    TELEGRAM_WEBHOOK_SECRET?: string;
    /** The owner's numeric Telegram user id, the only sender the bot answers. A secret so it stays out of the repo. */
    TELEGRAM_OWNER_ID?: string;
  }
  namespace Cloudflare {
    interface Env {
      TELEGRAM_BOT_TOKEN?: string;
      TELEGRAM_WEBHOOK_SECRET?: string;
      TELEGRAM_OWNER_ID?: string;
    }
  }
}

export {};
