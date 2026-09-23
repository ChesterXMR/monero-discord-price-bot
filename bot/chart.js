// Candlestick chart rendering for the /chart command.
// Data comes from Kraken's OHLC endpoint; the image is drawn locally with @napi-rs/canvas,
// so no external chart service is involved.
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
GlobalFonts.registerFromPath(path.join(here, "fonts", "DejaVuSans.ttf"), "DejaVu");
GlobalFonts.registerFromPath(path.join(here, "fonts", "DejaVuSans-Bold.ttf"), "DejaVu Bold");

/**
 * Timeframes offered by /chart. `kraken` is the Kraken OHLC interval in minutes,
 * `count` how many candles to show. Monthly candles are aggregated from weekly ones
 * because Kraken has no monthly interval.
 */
export const TIMEFRAMES = {
  "15m": { label: "15m", caption: "15-minute candles · last 24 hours", kraken: 15, count: 96, tick: "hour" },
  "1h": { label: "1h", caption: "1-hour candles · last 7 days", kraken: 60, count: 168, tick: "day" },
  "4h": { label: "4h", caption: "4-hour candles · last 30 days", kraken: 240, count: 180, tick: "day" },
  "1d": { label: "1d", caption: "Daily candles · last 6 months", kraken: 1440, count: 180, tick: "month" },
  "1w": { label: "1w", caption: "Weekly candles · last 3 years", kraken: 10080, count: 156, tick: "year" },
  "1M": { label: "1M", caption: "Monthly candles · since 2016", kraken: 10080, count: 0, tick: "year", monthly: true },
};

const cache = new Map(); // timeframe -> { at, candles }
const CACHE_MS = 60_000;

/** Fetch candles for a timeframe. Returns [{ t, o, h, l, c, v }] oldest first. */
export async function fetchCandles(pair, tf, kraken) {
  const spec = TIMEFRAMES[tf];
  const hit = cache.get(tf);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.candles;

  const result = await kraken(`OHLC?pair=${pair}&interval=${spec.kraken}`);
  const raw = Object.values(result).find(Array.isArray) ?? [];
  let candles = raw.map((r) => ({
    t: Number(r[0]) * 1000,
    o: Number(r[1]),
    h: Number(r[2]),
    l: Number(r[3]),
    c: Number(r[4]),
    v: Number(r[6]),
  }));
  if (spec.monthly) candles = toMonthly(candles);
  addEmas(candles, EMA_PERIODS);
  if (spec.count) candles = candles.slice(-spec.count);
  cache.set(tf, { at: Date.now(), candles });
  return candles;
}

export const EMA_PERIODS = [20, 50];

/** Attach ema[period] to each candle, computed over the whole series (oldest first). */
function addEmas(candles, periods) {
  for (const period of periods) {
    const k = 2 / (period + 1);
    let ema = null;
    candles.forEach((c, i) => {
      if (i < period - 1) { c.ema ??= {}; c.ema[period] = null; return; }
      if (ema === null) {
        // Seed with the simple average of the first `period` closes.
        ema = candles.slice(i - period + 1, i + 1).reduce((a, x) => a + x.c, 0) / period;
      } else {
        ema = c.c * k + ema * (1 - k);
      }
      c.ema ??= {};
      c.ema[period] = ema;
    });
  }
}

/** Group weekly candles by the calendar month their week starts in. */
function toMonthly(weekly) {
  const months = new Map();
  for (const w of weekly) {
    const d = new Date(w.t);
    const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const m = months.get(key);
    if (!m) months.set(key, { t: key, o: w.o, h: w.h, l: w.l, c: w.c, v: w.v });
    else {
      m.h = Math.max(m.h, w.h);
      m.l = Math.min(m.l, w.l);
      m.c = w.c;
      m.v += w.v;
    }
  }
  return [...months.values()].sort((a, b) => a.t - b.t);
}

const COLORS = {
  bg: "#000000",
  frame: "#ff6600", // Monero orange
  grid: "#1e1e1e",
  text: "#c9ccd3",
  dim: "#8a8d96",
  up: "#00e676",
  down: "#ff3b3b",
  upVol: "rgba(0,230,118,0.7)",
  downVol: "rgba(255,59,59,0.7)",
  last: "#9598a1",
  ema: { 20: "#f5a623", 50: "#2f80ed" },
};

function fmtPrice(n) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtVol(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(0);
}

/** Choose a "nice" price step so the axis has ~6 gridlines. */
function niceStep(range, target = 12) {
  const rough = range / target;
  const pow = 10 ** Math.floor(Math.log10(rough));
  for (const m of [1, 2, 2.5, 5, 10]) if (rough <= m * pow) return m * pow;
  return 10 * pow;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Time-axis labels: one per day / month / year boundary depending on the timeframe. */
function timeTicks(candles, mode) {
  const ticks = [];
  let prev = null;
  candles.forEach((c, i) => {
    const d = new Date(c.t);
    // Boundary key per mode: hour -> every hour, day -> every day, month -> 1st and 15th,
    // year -> January and July.
    const half = mode === "month" ? (d.getUTCDate() >= 15 ? 1 : 0) : mode === "year" ? (d.getUTCMonth() >= 6 ? 1 : 0) : 0;
    const key =
      mode === "hour" ? d.getUTCHours() + d.getUTCDate() * 24 :
      mode === "day" ? d.getUTCDate() + d.getUTCMonth() * 31 :
      mode === "month" ? d.getUTCMonth() * 2 + half :
      d.getUTCFullYear() * 2 + half;
    if (key !== prev) {
      if (prev !== null) {
        const label =
          mode === "hour" ? (d.getUTCHours() === 0 ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : `${String(d.getUTCHours()).padStart(2, "0")}:00`) :
          mode === "day" ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` :
          mode === "month" ? (half ? String(d.getUTCDate()) : d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : MONTHS[d.getUTCMonth()]) :
          (half ? MONTHS[d.getUTCMonth()] : String(d.getUTCFullYear()));
        ticks.push({ i, label });
      }
      prev = key;
    }
  });
  // Thin out crowded axes.
  const maxTicks = 20;
  const every = Math.ceil(ticks.length / maxTicks);
  return ticks.filter((_, n) => n % every === 0);
}

/**
 * Render a PNG buffer.
 * @param {object} opts { candles, title, exchange, tfLabel, quoteSymbol }
 */
export function renderChart({ candles, title, exchange, tfLabel, mode }) {
  const W = 1280, H = 720;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Background and frame
  ctx.fillStyle = COLORS.frame;
  ctx.fillRect(0, 0, W, H);
  const F = 6; // frame thickness
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(F, F, W - 2 * F, H - 2 * F);

  // Layout
  const left = 28, right = W - 124, top = 100, bottom = H - 60;
  const volTop = bottom - 110;      // volume pane occupies the bottom 110 px
  const priceBottom = volTop - 14;
  const plotW = right - left;
  const n = candles.length;
  const slot = plotW / n;
  const bodyW = Math.max(3, Math.floor(slot * 0.7));

  const min = Math.min(...candles.map((c) => c.l));
  const max = Math.max(...candles.map((c) => c.h));
  const pad = (max - min) * 0.08;
  const pMin = min - pad, pMax = max + pad;
  const yOf = (p) => top + ((pMax - p) / (pMax - pMin)) * (priceBottom - top);
  const xOf = (i) => left + i * slot + slot / 2;
  const vMax = Math.max(...candles.map((c) => c.v)) || 1;

  // Horizontal grid + price labels
  ctx.font = "19px DejaVu";
  ctx.textBaseline = "middle";
  const step = niceStep(pMax - pMin);
  for (let p = Math.ceil(pMin / step) * step; p <= pMax; p += step) {
    const y = yOf(p);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "left";
    ctx.fillText(fmtPrice(Math.abs(p) < step / 2 ? 0 : p), right + 12, y);
  }

  // Vertical grid + time labels
  const ticks = timeTicks(candles, mode);
  ctx.textAlign = "center";
  for (const { i, label } of ticks) {
    const x = xOf(i);
    ctx.strokeStyle = COLORS.grid;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.fillText(label, x, bottom + 26);
  }

  // Volume bars
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const h = ((c.v / vMax) * (bottom - volTop)) || 0;
    ctx.fillStyle = c.c >= c.o ? COLORS.upVol : COLORS.downVol;
    ctx.fillRect(xOf(i) - bodyW / 2, bottom - h, bodyW, h);
  }

  // Candles
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const up = c.c >= c.o;
    const color = up ? COLORS.up : COLORS.down;
    const x = xOf(i);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(2, Math.floor(slot * 0.15));
    ctx.beginPath(); ctx.moveTo(x, yOf(c.h)); ctx.lineTo(x, yOf(c.l)); ctx.stroke();
    const yO = yOf(c.o), yC = yOf(c.c);
    const bodyTop = Math.min(yO, yC);
    const bodyH = Math.max(1, Math.abs(yC - yO));
    ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
  }

  // EMA lines
  for (const period of EMA_PERIODS) {
    ctx.strokeStyle = COLORS.ema[period];
    ctx.lineWidth = 2.5;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = candles[i].ema?.[period];
      if (v == null) continue;
      const x = xOf(i), y = yOf(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Last price line + tag
  const last = candles[n - 1];
  const yLast = yOf(last.c);
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = COLORS.last;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(left, yLast); ctx.lineTo(right, yLast); ctx.stroke();
  ctx.setLineDash([]);
  const tag = fmtPrice(last.c);
  ctx.font = "bold 19px DejaVu Bold";
  const tagW = ctx.measureText(tag).width + 16;
  ctx.fillStyle = last.c >= last.o ? COLORS.up : COLORS.down;
  ctx.fillRect(right + 4, yLast - 15, tagW, 30);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.fillText(tag, right + 12, yLast);

  // Header
  const prevClose = n > 1 ? candles[n - 2].c : last.o;
  const chg = last.c - prevClose;
  const chgPct = (chg / prevClose) * 100;
  ctx.font = "bold 28px DejaVu Bold";
  ctx.fillStyle = "#e6e8ec";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const head = `${title} · ${tfLabel} · ${exchange}`;
  ctx.fillText(head, left, 46);
  let x = left + ctx.measureText(head).width + 20;
  ctx.font = "21px DejaVu";
  const parts = [
    ["O", fmtPrice(last.o)], ["H", fmtPrice(last.h)], ["L", fmtPrice(last.l)], ["C", fmtPrice(last.c)],
  ];
  const chgColor = chg >= 0 ? COLORS.up : COLORS.down;
  for (const [k, v] of parts) {
    ctx.fillStyle = COLORS.dim; ctx.fillText(k, x, 46); x += ctx.measureText(k).width + 5;
    ctx.fillStyle = chgColor; ctx.fillText(v, x, 46); x += ctx.measureText(v).width + 14;
  }
  const chgText = `${chg >= 0 ? "+" : ""}${fmtPrice(chg)} (${chg >= 0 ? "+" : ""}${chgPct.toFixed(2)}%)`;
  ctx.fillStyle = chgColor;
  ctx.fillText(chgText, x, 46);
  ctx.font = "19px DejaVu";
  ctx.fillStyle = COLORS.dim;
  ctx.fillText("Volume", left, 78);
  ctx.fillStyle = chgColor;
  ctx.fillText(fmtVol(last.v), left + 84, 78);
  let lx = left + 84 + ctx.measureText(fmtVol(last.v)).width + 28;
  for (const period of EMA_PERIODS) {
    const v = last.ema?.[period];
    const text = `EMA ${period}`;
    ctx.fillStyle = COLORS.dim; ctx.fillText(text, lx, 78); lx += ctx.measureText(text).width + 6;
    const val = v == null ? "–" : fmtPrice(v);
    ctx.fillStyle = COLORS.ema[period]; ctx.fillText(val, lx, 78); lx += ctx.measureText(val).width + 24;
  }

  return canvas.toBuffer("image/png");
}
