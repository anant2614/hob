#!/usr/bin/env bash
# Connects a Telegram bot to your deployed Fennec. Run it yourself, after the first deploy:
#
#   scripts/telegram-setup.sh https://agent.example.com
#
# It asks for the bot token without echoing it, finds your Telegram user id from one
# message you send the bot, and stores the token, your id and a fresh webhook secret
# as Worker secrets. Nothing is written to disk, so nothing personal reaches the repo.
#
# Before running it, give the Access application a Bypass policy for exactly
# /hooks/telegram (README, "Telegram"): Telegram can't sign in through Access.
set -euo pipefail
cd "$(dirname "$0")/.."

ORIGIN="${1:?usage: scripts/telegram-setup.sh https://<your Fennec hostname>}"
ORIGIN="${ORIGIN%/}"

read -rsp "Paste your bot token from @BotFather (input hidden): " TOKEN
echo
API="https://api.telegram.org/bot${TOKEN}"
WEBHOOK_SECRET="$(openssl rand -hex 32)"

# getUpdates only works while no webhook is set, so clear any earlier one first.
curl -fsS "${API}/deleteWebhook" >/dev/null || { echo "Telegram rejected that token."; exit 1; }

echo "Open your bot in Telegram and send it any message (for example: hi). Waiting up to 2 minutes..."
OWNER_ID=""
for _ in $(seq 1 60); do
  OWNER_ID="$(curl -fsS "${API}/getUpdates" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const updates = (JSON.parse(s).result || []).reverse();
      const hit = updates.find((u) => u.message && u.message.from && u.message.from.id);
      process.stdout.write(hit ? String(hit.message.from.id) : "");
    });')"
  [ -n "$OWNER_ID" ] && break
  sleep 2
done
[ -n "$OWNER_ID" ] || { echo "No message arrived. Send your bot a message and run this again."; exit 1; }
echo "Found your Telegram user id. Only messages from it will be answered."

# Each `wrangler secret put` deploys a new version, which restarts the agent.
printf '%s' "$TOKEN" | pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
printf '%s' "$OWNER_ID" | pnpm exec wrangler secret put TELEGRAM_OWNER_ID
printf '%s' "$WEBHOOK_SECRET" | pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET

curl -fsS "${API}/setWebhook" \
  --data-urlencode "url=${ORIGIN}/hooks/telegram" \
  --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]' \
  --data-urlencode "drop_pending_updates=true" >/dev/null
echo "Webhook set. Send your bot a message; the answer arrives in a few seconds."
