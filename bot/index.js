import {
  Client, GatewayIntentBits, ActivityType, EmbedBuilder, AttachmentBuilder,
  SlashCommandBuilder, MessageFlags,
} from "discord.js";
import { fetchCandles, renderChart, TIMEFRAMES } from "./chart.js";

const TOKEN = process.env.DISCORD_TOKEN;
const PAIR = (process.env.PAIR || "XMRUSD").toUpperCase();
const NICK_INTERVAL = Math.max(5, Number(process.env.NICK_INTERVAL) || 30) * 1000;
const PRESENCE_INTERVAL = Math.max(5, Number(process.env.PRESENCE_INTERVAL) || 15) * 1000;

if (!TOKEN) {
  console.error("DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const QUOTE_SYMBOL = { USD: "$", EUR: "€", GBP: "£", XBT: "₿", BTC: "₿", USDT: "$" };
const QUOTE_NAME = { USD: "U.S. Dollar", EUR: "Euro", GBP: "British Pound", XBT: "Bitcoin", BTC: "Bitcoin", USDT: "Tether" };
const quote = PAIR.replace(/^XMR/, "");
const symbol = QUOTE_SYMBOL[quote] ?? `${quote} `;
const PAIR_TITLE = `Monero / ${QUOTE_NAME[quote] ?? quote}`;
const XMR_LOGO = "https://assets.coingecko.com/coins/images/69/large/monero_logo.png";
const INVITE_SCOPES = "bot%20applications.commands";

/** Fetch the Kraken ticker for PAIR. Returns { last, open, high, low, changePct }. */
const KRAKEN = "https://api.kraken.com/0/public";

async function kraken(path) {
  // A fresh timeout signal per request: AbortSignal.timeout() fires once, so it must not be shared.
  const res = await fetch(`${KRAKEN}/${path}`, {
    headers: { "User-Agent": "monero-discord-price-bot" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
  const body = await res.json();
  if (body.error?.length) throw new Error(`Kraken: ${body.error.join(", ")}`);
  return body.result;
}

/** Price 24 hours ago: the open of the first 5-minute candle at or after now-24h. */
async function priceDayAgo() {
  const since = Math.floor(Date.now() / 1000) - 24 * 3600 - 300;
  const result = await kraken(`OHLC?pair=${PAIR}&interval=5&since=${since}`);
  const candles = Object.values(result).find(Array.isArray);
  if (!candles?.length) throw new Error("Kraken: no OHLC data");
  return Number(candles[0][1]);
}

/** Rolling 24h figures: last price, 24h high/low, and change vs the price 24h ago. */
async function fetchPrice() {
  const [ticker, dayAgo] = await Promise.all([kraken(`Ticker?pair=${PAIR}`), priceDayAgo()]);
  const t = Object.values(ticker)[0];
  const last = Number(t.c[0]);
  return {
    last,
    high: Number(t.h[1]),
    low: Number(t.l[1]),
    volume: Number(t.v[1]),
    changePct: ((last - dayAgo) / dayAgo) * 100,
  };
}

function fmt(n) {
  const digits = n >= 100 ? 2 : n >= 1 ? 3 : 6;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function nickname(p) {
  const arrow = p.changePct >= 0 ? "▲" : "▼";
  return `${symbol}${fmt(p.last)} (${arrow}${Math.abs(p.changePct).toFixed(1)}%)`.slice(0, 32); // Discord nickname limit
}

function presenceText(p) {
  return `HIGH: ${symbol}${fmt(p.high)} ▌LOW: ${symbol}${fmt(p.low)}`.slice(0, 128);
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
    activities: [{ name: "status", state: presenceText(latest), type: ActivityType.Custom }],
  });
}

// ---------- Slash commands ----------

const commands = [
  new SlashCommandBuilder().setName("price").setDescription("Current XMR price with 24h change, high, low and volume"),
  new SlashCommandBuilder()
    .setName("chart")
    .setDescription("XMR candlestick chart")
    .addStringOption((o) =>
      o.setName("timeframe")
        .setDescription("Candle size (default: 15-minute candles, last 24 hours)")
        .addChoices(...Object.entries(TIMEFRAMES).map(([value, tf]) => ({ name: tf.label, value }))),
    ),
];

function priceEmbed(p) {
  const up = p.changePct >= 0;
  const sign = up ? "+" : "";
  return new EmbedBuilder()
    .setColor(up ? 0x26a69a : 0xef5350)
    .setAuthor({ name: PAIR_TITLE, iconURL: XMR_LOGO })
    .setDescription(`## ${symbol}${fmt(p.last)} (${sign}${p.changePct.toFixed(2)}%)`)
    .addFields(
      { name: "24h High", value: `${symbol}${fmt(p.high)}`, inline: true },
      { name: "24h Low", value: `${symbol}${fmt(p.low)}`, inline: true },
      { name: "24h Volume", value: `${Math.round(p.volume).toLocaleString("en-US")} XMR`, inline: true },
    )
    .setFooter({ text: "Kraken · change vs 24h ago" })
    .setTimestamp();
}

async function handlePrice(interaction) {
  const p = latest ?? (await fetchPrice());
  await interaction.reply({ embeds: [priceEmbed(p)] });
}

async function handleChart(interaction) {
  const tf = interaction.options.getString("timeframe") ?? "15m";
  const spec = TIMEFRAMES[tf];
  await interaction.deferReply();
  const candles = await fetchCandles(PAIR, tf, kraken);
  if (candles.length < 2) throw new Error("not enough candle data");
  const png = renderChart({ candles, title: PAIR_TITLE, exchange: "KRAKEN", tfLabel: spec.label, mode: spec.tick });
  const file = new AttachmentBuilder(png, { name: `xmr-${tf}.png` });
  const last = candles.at(-1);
  const embed = new EmbedBuilder()
    .setColor(last.c >= last.o ? 0x26a69a : 0xef5350)
    .setImage(`attachment://xmr-${tf}.png`)
    .setFooter({ text: `Kraken · ${spec.label} candles` })
    .setTimestamp();
  await interaction.editReply({ embeds: [embed], files: [file] });
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === "price") await handlePrice(interaction);
    else if (interaction.commandName === "chart") await handleChart(interaction);
  } catch (err) {
    console.error(`/${interaction.commandName} failed:`, err.message);
    const msg = { content: "Couldn't fetch data from Kraken right now. Try again in a moment.", flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
});

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag} in ${client.guilds.cache.size} guild(s); pair ${PAIR}`);
  console.log(`Invite: https://discord.com/oauth2/authorize?client_id=${client.user.id}&scope=${INVITE_SCOPES}&permissions=67108864`);
  try {
    await client.application.commands.set(commands);
    console.log("Slash commands registered: /price, /chart");
  } catch (err) {
    console.error("could not register slash commands:", err.message);
  }
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
