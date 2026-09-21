# Monero Discord price bot

A Discord bot whose **server nickname is the live XMR price** (for example `XMR $580.44`),
with an optional status line showing today's change and high/low.
Price comes from Kraken's public ticker (no API key needed).

Two deployable flavours live in this repo:

| Folder    | What it is                                   | Refresh       | Shows                                  | Runs on                                         |
|-----------|----------------------------------------------|---------------|----------------------------------------|-------------------------------------------------|
| `worker/` | Cloudflare Worker fired by a cron trigger    | every 15 s (configurable) | nickname only              | Cloudflare Workers free plan (no card, no VM)   |
| `bot/`    | Always-on Node.js bot (discord.js)           | 10-30 s       | nickname + status line (`▲ 2.77% today · H 633.90 L 519.17`) | Any free VM: Oracle Always Free, Google e2-micro |

**Which one:** the VM bot is the full experience (bot shows online, with a status line). The
Worker is the zero-maintenance fallback: it needs no server, but the bot appears offline in the
member list because it never holds a gateway connection. Run one or the other, not both; the
Worker's cron is disabled in `wrangler.toml` by default. Details in [Hosting](#hosting).

> Do not automate a normal Discord *user* account for this. Self-bots are against Discord's
> Terms of Service and get accounts banned. A bot account is the supported way.

---

## 1. Create the Discord bot (once, for either flavour)

1. Go to https://discord.com/developers/applications and click **New Application**. Name it e.g. `XMR Price`.
2. Left menu **Bot** → **Reset Token** → copy the token. This is your `DISCORD_TOKEN`. Keep it secret.
3. Still under **Bot**, no privileged intents are needed. Leave them off.
4. Left menu **OAuth2** → **URL Generator**:
   - Scopes: `bot`
   - Bot permissions: **Change Nickname**
   - Or just use this URL with your Application ID:
     `https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot&permissions=67108864`
5. Open the URL, pick your server, authorise.
6. Under **Bot**, make sure **Public Bot** is on (it is by default). That lets anyone with the invite
   URL add the bot to their own server; you don't need to be a member or know the server ID.
   Both the Worker and the Node bot discover their servers automatically through Discord's API.

Note: the bot's *username* can only change twice per hour, so the price goes in its
per-server **nickname**, which is what everyone sees in the member list and in chat.

---

## 2a. Cloudflare Worker (recommended)

Requires a free Cloudflare account and Node.js on your PC for the one-time deploy.

```bash
cd worker
npm install
npx wrangler login                     # opens a browser to authorise
npx wrangler secret put DISCORD_TOKEN  # paste the bot token when prompted
npx wrangler deploy
```

### Automatic deploys from GitHub (optional)

Push this repo to GitHub, then in the Cloudflare dashboard open **Workers & Pages → monero-price-worker
→ Settings → Build** and connect the repository. Set **Root directory** to `worker`, leave the
build command empty, and keep the deploy command `npx wrangler deploy`. From then on every push
to `main` deploys automatically; the token stays in Cloudflare's secrets and is never in the repo.

That's it. The cron trigger `* * * * *` fires once a minute forever, and each run loops for
about 55 seconds, updating the nickname every `UPDATE_INTERVAL` seconds (default 15). Sleeping
between updates uses no CPU time, so this stays well inside the free plan. To check it, open the
`https://monero-price-worker.<your-subdomain>.workers.dev` URL the deploy prints: it performs an
update and returns JSON with the nickname it set and any per-server error.

### Letting other people add the bot

Share the invite URL from step 4 above. Whoever has *Manage Server* on a Discord server can open
it, pick their server, and authorise. The Worker picks the new server up on its next one-minute
run. No configuration change and no redeploy needed. To limit the bot to specific servers
instead, set `GUILD_IDS` in `wrangler.toml` to a comma-separated list of server IDs.

Local test before deploying:

```bash
cp .dev.vars.example .dev.vars   # put the real token in it
npm run dev                      # then open http://localhost:8787/
```

Free-plan numbers that matter: 100,000 requests/day (this uses 1,440), 3 cron triggers per
worker, 10 ms CPU per run (network wait doesn't count). No credit card required.

---

## 2b. Always-on Node bot on a free VM

```bash
cd bot
cp .env.example .env    # fill in DISCORD_TOKEN; optionally PAIR, NICK_INTERVAL, PRESENCE_INTERVAL
npm install
npm start
```

Console output on success:

```
Logged in as XMR Price#1234 in 1 guild(s); pair XMRUSD
2026-09-21T17:05:02.114Z XMR $580.44 -> 1/1 guild(s)
```

Behaviour:

- Nickname is written every `NICK_INTERVAL` seconds (default 30) in every server the bot is in,
  and skipped when the text hasn't changed so no rate-limit budget is wasted.
- Status line ("Watching ▲ 2.77% today · H 633.90 L 519.17") refreshes every
  `PRESENCE_INTERVAL` seconds (default 15). The bot shows green (online) when up on the day
  and red (do not disturb) when down.
- discord.js queues and retries automatically on Discord 429s; a `rate limited` warning in the
  log means `NICK_INTERVAL` is too low. 10 s is about the practical floor.

### Run it on a Linux VM (one command)

On a fresh Debian or Ubuntu VM, run:

```bash
curl -fsSL https://raw.githubusercontent.com/ChesterXMR/monero-discord-price-bot/main/bot/setup-vm.sh | bash
```

It installs Node 22, clones this repo, asks for the bot token once, and installs two systemd
units: the bot itself (starts on boot, restarts on crash) and a timer that checks GitHub every
5 minutes and restarts the bot whenever `main` changes. Pushing to GitHub is all it takes to
update a running VM.

```bash
journalctl -u monero-price-bot -f          # bot log
journalctl -u monero-price-bot-update      # auto-update log
sudo systemctl restart monero-price-bot    # manual restart
```

A `Dockerfile` is included if you prefer containers (`docker build -t xmr-bot . && docker run -d --env-file .env --restart unless-stopped xmr-bot`).

---

## Hosting

| Option | Cost | Card needed | Refresh floor | Gotchas |
|---|---|---|---|---|
| **Cloudflare Workers** (worker/) | Free forever | No | ~10 s (15 s default) | Nickname only, no status line. Nothing to maintain. |
| **Oracle Cloud Always Free** (bot/) | Free forever | Yes (verification only) | ~10 s | Oracle reclaims free VMs that sit under 20 % CPU/RAM/network for 7 days, and this bot is nearly idle. Fix: upgrade the account to Pay As You Go (Always Free resources stay unbilled) or accept the risk. Signups sometimes fail with "out of capacity". |
| **Google Cloud e2-micro** (bot/) | Free forever in US regions | Yes | ~10 s | No idle reclaim. 1 GB/month free egress, which this bot uses a tiny fraction of. Needs a billing account, so watch for accidental extras. |
| Render / Railway / Fly free tiers | Trial credits or sleeping instances | Varies | n/a | Free web services sleep when idle, which disconnects a Discord bot. Not suitable. |
| GitHub Actions cron | Free on public repos | No | 5 min, often 10-30 min late | Schedules get disabled after 60 days without a commit. Too slow for a ticker. |

Why the Worker first: it refreshes as fast as Discord's nickname route sensibly allows, and it
has zero moving parts.
If you later want the status line, deploy `bot/` to a VM and delete the Worker's cron trigger so
the two don't fight over the nickname.

---

## Configuration reference

| Variable | Where | Default | Meaning |
|---|---|---|---|
| `DISCORD_TOKEN` | both (secret) | required | Bot token |
| `PAIR` | both | `XMRUSD` | Any Kraken XMR pair: `XMRUSD`, `XMREUR`, `XMRXBT` |
| `GUILD_IDS` | worker | empty | Optional. Comma-separated server IDs to restrict the bot to; empty means every server it has been added to |
| `UPDATE_INTERVAL` | worker | `15` | Seconds between updates inside each one-minute cron run (min 5) |
| `NICK_INTERVAL` | bot | `30` | Seconds between nickname writes (min 5) |
| `PRESENCE_INTERVAL` | bot | `15` | Seconds between status-line updates (min 5) |

## Troubleshooting

- **`Discord HTTP 403` / `Missing Permissions`**: the bot lacks *Change Nickname* in that server, or its role is below a role that restricts it. Re-invite with the URL above or grant the permission under Server Settings → Roles.
- **`Discord HTTP 401`**: wrong token. Reset it in the developer portal and set it again.
- **`Kraken: EQuery:Unknown asset pair`**: `PAIR` isn't a Kraken pair. Check https://api.kraken.com/0/public/AssetPairs.
- **Nickname doesn't change but log says ok**: Discord's client caches member lists; switch channels or restart Discord.
