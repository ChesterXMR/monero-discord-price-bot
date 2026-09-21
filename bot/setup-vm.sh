#!/usr/bin/env bash
# One-shot installer for a fresh Debian/Ubuntu VM (Google Cloud e2-micro, Oracle, any VPS).
# Installs Node 22, clones the repo, asks for the Discord token, and runs the bot as a
# systemd service that starts on boot and restarts on crashes.
#
#   curl -fsSL https://raw.githubusercontent.com/ChesterXMR/monero-discord-price-bot/main/bot/setup-vm.sh | bash
#
set -euo pipefail

REPO="https://github.com/ChesterXMR/monero-discord-price-bot.git"
DIR="$HOME/monero-discord-price-bot"
SERVICE="monero-price-bot"

echo "==> Installing Node.js 22 and git"
if ! command -v node >/dev/null || [ "$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y git

echo "==> Fetching the bot"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi
cd "$DIR/bot"
npm ci --omit=dev --no-audit --no-fund

if [ ! -f .env ]; then
  echo
  echo "Paste the Discord bot token (input is hidden), then press Enter:"
  read -rs DISCORD_TOKEN < /dev/tty
  echo
  [ -n "$DISCORD_TOKEN" ] || { echo "No token given, aborting."; exit 1; }
  cat > .env <<ENV
DISCORD_TOKEN=$DISCORD_TOKEN
PAIR=XMRUSD
NICK_INTERVAL=15
PRESENCE_INTERVAL=15
ENV
  chmod 600 .env
fi

echo "==> Installing systemd service"
sudo tee /etc/systemd/system/$SERVICE.service >/dev/null <<UNIT
[Unit]
Description=Monero Discord price bot
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR/bot
EnvironmentFile=$DIR/bot/.env
ExecStart=$(command -v node) index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT

echo "==> Installing auto-update timer (checks GitHub every 5 minutes)"
chmod +x "$DIR/bot/update.sh"
# Let the updater restart the service without a password prompt.
echo "$USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE" | sudo tee /etc/sudoers.d/$SERVICE >/dev/null
sudo chmod 440 /etc/sudoers.d/$SERVICE
sudo tee /etc/systemd/system/$SERVICE-update.service >/dev/null <<UNIT
[Unit]
Description=Pull latest monero-discord-price-bot from GitHub

[Service]
Type=oneshot
User=$USER
ExecStart=/bin/bash $DIR/bot/update.sh
UNIT

sudo tee /etc/systemd/system/$SERVICE-update.timer >/dev/null <<UNIT
[Unit]
Description=Check GitHub for bot updates every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now $SERVICE
sudo systemctl restart $SERVICE
sudo systemctl enable --now $SERVICE-update.timer
sleep 5
echo
sudo systemctl --no-pager status $SERVICE | head -n 12
echo
echo "Done. The bot restarts itself on every push to GitHub (checked every 5 minutes)."
echo "Follow the log with:   journalctl -u $SERVICE -f"
echo "Update log:            journalctl -u $SERVICE-update"
