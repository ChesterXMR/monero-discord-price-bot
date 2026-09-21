// Cloudflare Worker: every minute, fetch the XMR price from Kraken and set it
// as the bot's nickname in each configured guild via Discord's REST API.
// No gateway connection is needed for nickname changes, so this runs for free
// on Cloudflare's cron triggers with nothing to keep alive.

const QUOTE_SYMBOL = { USD: "$", EUR: "€", GBP: "£", XBT: "₿", BTC: "₿", USDT: "$" };

async function fetchPrice(pair) {
  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`, {
    headers: { "User-Agent": "monero-discord-price-bot" },
  });
  if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
  const body = await res.json();
  if (body.error?.length) throw new Error(`Kraken: ${body.error.join(", ")}`);
  const t = Object.values(body.result)[0];
  const last = Number(t.c[0]);
  const open = Number(t.o);
  return { last, open, changePct: ((last - open) / open) * 100 };
}

function fmt(n) {
  const digits = n >= 100 ? 2 : n >= 1 ? 3 : 6;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function nickname(pair, p) {
  const arrow = p.changePct >= 0 ? "▲" : "▼";
  return `[XMR] ${fmt(p.last)} ${arrow}`.slice(0, 32);
}

async function setNickname(env, guildId, nick) {
  const res = await fetch(`${DISCORD_API}/guilds/${guildId}/members/@me`, {
    method: "PATCH",
    headers: {
      ...authHeaders(env),
      "Content-Type": "application/json",
      "X-Audit-Log-Reason": "XMR price update",
    },
    body: JSON.stringify({ nick }),
  });
  if (res.status === 429) {
    const retry = res.headers.get("retry-after");
    throw new Error(`rate limited, retry after ${retry}s (next cron will retry)`);
  }
  if (!res.ok) throw new Error(`Discord HTTP ${res.status}: ${await res.text()}`);
}

const DISCORD_API = "https://discord.com/api/v10";

function authHeaders(env) {
  return { Authorization: `Bot ${env.DISCORD_TOKEN}` };
}

/**
 * Every server the bot has been added to. Uses the bot token's own guild list,
 * so nobody has to configure server IDs: adding the bot via the invite link is
 * enough. GUILD_IDS can still be set to restrict it to specific servers.
 */
async function listGuilds(env) {
  const configured = String(env.GUILD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (configured.length) return configured;
  const ids = [];
  let after = "0";
  for (;;) {
    const res = await fetch(`${DISCORD_API}/users/@me/guilds?limit=200&after=${after}`, {
      headers: authHeaders(env),
    });
    if (!res.ok) throw new Error(`Discord guild list HTTP ${res.status}: ${await res.text()}`);
    const page = await res.json();
    ids.push(...page.map((g) => g.id));
    if (page.length < 200) break;
    after = page[page.length - 1].id;
  }
  return ids;
}

function settings(env) {
  if (!env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN secret is not set");
  return { pair: (env.PAIR || "XMRUSD").toUpperCase() };
}

/** One update: fetch the price and write the nickname to every guild. */
export async function run(env, lastNick = "", guilds = null) {
  const { pair } = settings(env);
  guilds ??= await listGuilds(env);
  if (guilds.length === 0) {
    console.log("bot is not in any server yet");
    return { nick: null, price: null, report: [] };
  }
  const price = await fetchPrice(pair);
  const nick = nickname(pair, price);
  if (nick === lastNick) {
    console.log(`${nick} | unchanged, skipped`);
    return { nick, price, report: guilds.map((g) => `${g}: unchanged`) };
  }
  const results = await Promise.allSettled(guilds.map((g) => setNickname(env, g, nick)));
  const report = results.map((r, i) =>
    r.status === "fulfilled" ? `${guilds[i]}: ok` : `${guilds[i]}: ${r.reason.message}`,
  );
  console.log(`${nick} | ${report.join(" | ")}`);
  return { nick, price, report };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cron fires once a minute (Cloudflare's floor), so each run loops for just
 * under a minute, updating every UPDATE_INTERVAL seconds. Sleeping costs no
 * CPU time, so this stays inside the free plan's 10 ms CPU budget.
 */
async function runLoop(env) {
  const interval = Math.max(5, Number(env.UPDATE_INTERVAL) || 15) * 1000;
  const budget = 55_000; // stop before the next cron fires so runs never overlap
  const started = Date.now();
  let lastNick = "";
  let guilds = null; // fetched once per minute; new servers are picked up on the next cron run
  for (let i = 0; ; i++) {
    try {
      guilds ??= await listGuilds(env);
      const out = await run(env, lastNick, guilds);
      if (out.report.some((r) => r.endsWith(": ok"))) lastNick = out.nick;
    } catch (err) {
      console.error(`update ${i + 1} failed: ${err.message}`);
    }
    const elapsed = Date.now() - started;
    if (elapsed + interval > budget) break;
    await sleep(interval);
  }
}

export default {
  // Cron entry point.
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runLoop(env));
  },

  // Visiting the worker URL shows the current price and a manual update
  // result, which is handy for checking the deploy works.
  async fetch(_request, env) {
    try {
      const out = await run(env);
      return Response.json({ ...out, guilds: out.report.length });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  },
};
