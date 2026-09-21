#!/usr/bin/env bash
# Pulls the latest main from GitHub and restarts the bot only if something changed.
# Run by the monero-price-bot-update.timer every 5 minutes (installed by setup-vm.sh).
set -euo pipefail
DIR="$HOME/monero-discord-price-bot"
SERVICE="monero-price-bot"

cd "$DIR"
git fetch -q origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ]; then
  exit 0
fi

echo "Updating $LOCAL -> $REMOTE"
git reset -q --hard origin/main
cd bot
if ! git diff --quiet "$LOCAL" "$REMOTE" -- package.json package-lock.json; then
  npm ci --omit=dev --no-audit --no-fund
fi
sudo /usr/bin/systemctl restart "$SERVICE"
echo "Restarted $SERVICE at $(git rev-parse --short HEAD)"
