import { Client, GatewayIntentBits, ActivityType } from "discord.js";

const TOKEN = process.env.DISCORD_TOKEN;
const PAIR = (process.env.PAIR || "XMRUSD").toUpperCase();
const NICK_INTERVAL = Math.max(5, Number(process.env.NICK_INTERVAL) || 30) * 1000;
const PRESENCE_INTERVAL = Math.max(5, Number(process.env.PRESENCE_INTERVAL) || 15) * 1000;

if (!TOKEN) {
  console.error("DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const QUOTE_SYMBOL = { USD: "$", EUR: "€", GBP: "£", XBT: "₿", BTC: "₿", USDT: "$" };
const quote = PAIR.replace(/^XMR/, "");
const symbol = QUOTE_SYMBOL[quote] ?? `${quote} `;

/** Fetch the Kraken ticker for PAIR. Returns { last, open, high, low, changePct }. */
async function fetchPrice() {
  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${PAIR}`, {
    headers: { "User-Agent": "monero-discord-price-bot" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
  const body = await res.json();
  if (body.error?.length) throw new Error(`Kraken: ${body.error.join(", ")}`);
  const t = Object.values(body.result)[0];
  const last = Number(t.c[0]);
  const open = Number(t.o);
  return {
    last,
    open,
    high: Number(t.h[0]),
    low: Number(t.l[0]),
    changePct: ((last - open) / open) * 100,
  };
}

function fmt(n) {
  const digits = n >= 100 ? 2 : n >= 1 ? 3 : 6;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function nickname(p) {
  return `XMR ${symbol}${fmt(p.last)}`.slice(0, 32); // Discord nickname limit
}

function presenceText(p) {
  const arrow = p.changePct >= 0 ? "▲" : "▼";
  return `${arrow} ${p.changePct.toFixed(2)}% today · H ${fmt(p.high)} L ${fmt(p.low)}`.slice(0, 128);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

let latest = null;          // last successfully fetched price
let lastNick = "";          // skip PATCHes when the text hasn't changed
let ticking = false;        // guard against overlapping ticks
const warnedGuilds = new Set();

async function updateNicknames() {
  if (ticking) return;
  ticking = true;
  try {
    latest = await fetchPrice();
    const nick = nickname(latest);
    if (nick === lastNick) return;
    const results = await Promise.allSettled(
      client.guilds.cache.map(async (guild) => {
        const me = guild.members.me ?? (await guild.members.fetchMe());
        if (me.nickname !== nick) await me.setNickname(nick, "XMR price update");
      }),
    );
    let ok = 0;
    results.forEach((r, i) => {
      const guild = client.guilds.cache.at(i);
      if (r.status === "fulfilled") { ok++; warnedGuilds.delete(guild.id); return; }
      if (!warnedGuilds.has(guild.id)) {
        console.error(`[${guild.name}] cannot set nickname: ${r.reason?.message ?? r.reason}`);
        warnedGuilds.add(guild.id);
      }
    });
    if (ok > 0) lastNick = nick;
    console.log(`${new Date().toISOString()} ${nick} -> ${ok}/${results.length} guild(s)`);
  } catch (err) {
    console.error("price update failed:", err.message);
  } finally {
    ticking = false;
  }
}

function updatePresence() {
  if (!latest || !client.user) return;
  client.user.setPresence({
    status: latest.changePct >= 0 ? "online" : "dnd",
    activities: [{ name: presenceText(latest), type: ActivityType.Watching }],
  });
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag} in ${client.guilds.cache.size} guild(s); pair ${PAIR}`);
  console.log(`Invite: https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=bot&permissions=67108864`);
  await updateNicknames();
  updatePresence();
  setInterval(updateNicknames, NICK_INTERVAL);
  setInterval(updatePresence, PRESENCE_INTERVAL);
});

client.on("guildCreate", (guild) => {
  console.log(`joined ${guild.name}`);
  lastNick = ""; // force a nickname write on the next tick
});

client.rest.on("rateLimited", (info) => {
  console.warn(`rate limited on ${info.route} for ${info.timeToReset}ms; lower NICK_INTERVAL less aggressively`);
});

process.on("unhandledRejection", (err) => console.error("unhandled:", err));
client.login(TOKEN);
