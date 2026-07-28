/**
 * WhaleTracker -> Telegram, on Cloudflare Workers.
 *
 * A direct port of the Python bot. Runs on a Cron Trigger every 2 minutes.
 * State (last processed message id + template rotation) lives in Workers KV.
 *
 * Free-plan budget per invocation: 50 subrequests, 10ms CPU. We use ~5 subrequests
 * and only write KV when something actually changed, to stay under 1,000 writes/day.
 */

const CONFIG = {
  entryZonePct: 0.4,
  stopLossPct: 5.0,
  takeProfitPcts: [4.0, 8.0, 12.0],
  maxSignalsPerRun: 12, // also keeps us well under the 50-subrequest ceiling
  excludeStablecoins: false,
  allowShorts: true,
};

// Each source has its own message format and therefore its own parser and its own
// commentary pool -- the pump channel publishes none of the order-flow statistics
// the WhaleTracker templates talk about.
const SOURCES = [
  { key: "whaletracker", channel: "WhaleTracker" },
  { key: "pumpdetector", channel: "cointrendz_pumpdetector" },
];

const STABLE_BASES = new Set([
  "USDT", "USDC", "RLUSD", "FDUSD", "TUSD", "BUSD", "DAI", "USDE", "USDD",
  "PYUSD", "USDP", "FRAX", "LUSD", "GUSD", "EURI", "EURT", "EURS", "USD1",
  "USDS", "SUSD", "CRVUSD", "USDG", "USDY",
]);

const QUOTES = ["USDT", "USDC", "FDUSD", "TUSD", "BTC", "ETH", "BNB", "EUR", "TRY"];
const STABLE_QUOTES = new Set(["USDT", "USDC", "FDUSD", "TUSD", "USD", ""]);
const SUFFIX = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

// ---------------------------------------------------------------- parsing

function toNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/,/g, "").replace(/−/g, "-");
  let mult = 1;
  const last = s.slice(-1).toUpperCase();
  if (SUFFIX[last]) {
    mult = SUFFIX[last];
    s = s.slice(0, -1);
  }
  const v = parseFloat(s);
  return Number.isNaN(v) ? null : v * mult;
}

function decimalsOf(raw) {
  const i = raw.indexOf(".");
  return i === -1 ? 0 : raw.length - i - 1;
}

function stripHtml(fragment) {
  return (
    fragment
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<[^>]+>/g, "")
      // Numeric entities matter: the pump channel emits "$" as &#036;, which would
      // otherwise break every price regex. Decode these BEFORE &amp; so a literal
      // "&amp;#036;" cannot be double-decoded.
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .trim()
  );
}

/**
 * Pull (id, text) pairs out of the public web preview.
 * Uses indexOf/slice rather than one big regex over ~100KB of HTML, to stay
 * comfortably inside the 10ms CPU budget.
 */
export function extractPosts(html) {
  const out = [];
  const ID_MARK = 'data-post="';
  const TEXT_MARK = 'js-message_text"';
  let cursor = 0;
  for (;;) {
    const idAt = html.indexOf(ID_MARK, cursor);
    if (idAt === -1) break;
    const idEnd = html.indexOf('"', idAt + ID_MARK.length);
    const post = html.slice(idAt + ID_MARK.length, idEnd); // "Channel/12345"
    const slash = post.lastIndexOf("/");
    const id = parseInt(post.slice(slash + 1), 10);

    const textAt = html.indexOf(TEXT_MARK, idEnd);
    if (textAt === -1) break;
    const open = html.indexOf(">", textAt);
    // next message's id marker bounds this one's body
    const nextId = html.indexOf(ID_MARK, open);
    const body = html.slice(open + 1, nextId === -1 ? html.length : nextId);
    const close = body.indexOf("</div>");
    if (id) out.push([id, stripHtml(close === -1 ? body : body.slice(0, close))]);
    cursor = nextId === -1 ? html.length : nextId;
    if (out.length > 120) break;
  }
  return out;
}

const RE_HEAD = /#([A-Z0-9]+)\s*(?:\S+\s*)?(Buying|Selling)\s+Volume/i;
const RE_ALERT_VOL = /^├\s*([\d.,]+[KMBT]?)\s*(\S+)\s+volume in\s+(\S+)/m;
const RE_BUY = /Buy\s*\[(-?[\d.]+)%\]/g;
const RE_SELL = /Sell\s*\[(-?[\d.]+)%\]/g;
const RE_PRICE = /Price:\s*([\d.,]+)\s*→\s*([\d.,]+)\s*\((-?[\d.]+)%\)/;
const RE_TF = /(24h|4h|15m|1h)\[(-?[\d.]+)%\]/g;
const RE_VOL24 = /24h Volume:\s*([\d.,]+[KMBT]?)/;
const RE_NETVOL = /Net Vol:\s*(.+)/;
const RE_ALERTS = /Alerts:\s*24h\[(\d+)\]\s*4h\[(\d+)\]/;

const QUOTE_SYMBOLS = { "₮": "USDT", "Ƀ": "BTC", "Ξ": "ETH", $: "USD" };

function allMatches(re, text) {
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push(m);
  return out;
}

function tfMap(text) {
  const o = {};
  for (const m of allMatches(RE_TF, text)) o[m[1]] = parseFloat(m[2]);
  return o;
}

export function parseMessage(text, msgId) {
  const head = text.match(RE_HEAD);
  if (!head) return null; // non-Latin tickers land here and are skipped by design

  const sig = { msgId, source: "whaletracker", symbol: head[1].toUpperCase(), side: head[2].toLowerCase() === "buying" ? "buy" : "sell" };

  sig.base = sig.symbol;
  sig.quote = "";
  for (const q of QUOTES) {
    if (sig.symbol.endsWith(q) && sig.symbol.length > q.length) {
      sig.base = sig.symbol.slice(0, -q.length);
      sig.quote = q;
      break;
    }
  }

  const av = text.match(RE_ALERT_VOL);
  if (av) {
    sig.alertVolume = toNumber(av[1]) || 0;
    sig.window = av[3];
    if (!sig.quote) sig.quote = QUOTE_SYMBOLS[av[2]] || "";
  } else {
    sig.alertVolume = 0;
    sig.window = "";
  }

  const buys = allMatches(RE_BUY, text);
  const sells = allMatches(RE_SELL, text);
  sig.buyPct = buys.length ? parseFloat(buys[0][1]) : 0;
  sig.sellPct = sells.length ? parseFloat(sells[0][1]) : 0;

  const p = text.match(RE_PRICE);
  if (!p) return null;
  sig.priceRaw = p[2];
  sig.price = toNumber(p[2]) || 0;
  sig.priceMovePct = parseFloat(p[3]);
  if (sig.price <= 0) return null;

  const ci = text.indexOf("Change:");
  const vi = text.indexOf("24h Volume:");
  sig.change = ci !== -1 && vi !== -1 ? tfMap(text.slice(ci, vi)) : {};

  const v24 = text.match(RE_VOL24);
  sig.vol24h = v24 ? toNumber(v24[1]) || 0 : 0;

  const nv = text.match(RE_NETVOL);
  sig.netVol = nv ? tfMap(nv[1]) : {};

  const al = text.match(RE_ALERTS);
  sig.alerts24h = al ? parseInt(al[1], 10) : 0;
  sig.alerts4h = al ? parseInt(al[2], 10) : 0;

  sig.direction = sig.side === "buy" ? "LONG" : "SHORT";
  sig.dominance = sig.side === "buy" ? sig.buyPct : Math.abs(sig.sellPct);
  return sig;
}

/**
 * cointrendz_pumpdetector format:
 *
 *   🚀 Pump - REZ/USDT [Binance]
 *   Pump Activity on REZ/USDT 🟢🟢
 *   💰Price: $0.00262 ➜ $0.00296 (+13.11%)
 *   📊Volume: $1.85M (+137.42%)
 *   Volume increased by $1.07M ⬆
 *
 * Note these fire AFTER the move has happened, so priceMovePct is typically large
 * and positive. Promotional posts have no price line and fall out as null.
 */
const RE_PD_HEAD = /(Pump|Dump)\s*-\s*([A-Z0-9]+)\/([A-Z]+)\s*(?:\[([^\]]+)\])?/i;
const RE_PD_PRICE = /Price:\s*\$?([\d.,]+)\s*(?:➜|->|→)\s*\$?([\d.,]+)\s*\(([-+]?[\d.]+)%\)/;
const RE_PD_VOL = /Volume:\s*\$?([\d.,]+[KMBT]?)\s*(?:\(([-+]?[\d.]+)%\))?/;
const RE_PD_VOLINC = /Volume (?:increased|decreased) by\s*\$?([\d.,]+[KMBT]?)/i;

export function parsePumpDetector(text, msgId) {
  const head = text.match(RE_PD_HEAD);
  if (!head) return null; // promos, bot showcases, anything off-format

  const price = text.match(RE_PD_PRICE);
  if (!price) return null;

  const sig = {
    msgId,
    source: "pumpdetector",
    base: head[2].toUpperCase(),
    quote: head[3].toUpperCase(),
    exchange: head[4] || "",
    side: head[1].toLowerCase() === "pump" ? "buy" : "sell",
  };
  sig.symbol = sig.base + sig.quote;
  sig.priceFromRaw = price[1];
  sig.priceRaw = price[2];
  sig.priceFrom = toNumber(price[1]) || 0;
  sig.price = toNumber(price[2]) || 0;
  sig.priceMovePct = parseFloat(price[3]);
  if (sig.price <= 0) return null;

  const vol = text.match(RE_PD_VOL);
  sig.vol24h = vol ? toNumber(vol[1]) || 0 : 0;
  sig.volChangePct = vol && vol[2] !== undefined ? parseFloat(vol[2]) : null;

  const inc = text.match(RE_PD_VOLINC);
  sig.volIncrease = inc ? toNumber(inc[1]) || 0 : 0;

  // fields the WhaleTracker templates expect but this source doesn't publish
  sig.alertVolume = sig.volIncrease;
  sig.window = "";
  sig.change = {};
  sig.netVol = {};
  sig.alerts24h = 0;
  sig.alerts4h = 0;
  sig.dominance = 0;

  sig.direction = sig.side === "buy" ? "LONG" : "SHORT";
  return sig;
}

export const PARSERS = { whaletracker: parseMessage, pumpdetector: parsePumpDetector };

// ---------------------------------------------------------------- levels

function precisionFor(price, refRaw) {
  let dec = decimalsOf(refRaw);
  while (dec < 12 && price > 0 && price < Math.pow(10, 3 - dec)) dec += 1;
  return dec;
}

export function buildSetup(sig, cfg) {
  const p = sig.price;
  const zone = cfg.entryZonePct / 100;
  const sl = cfg.stopLossPct / 100;
  const long = sig.side === "buy";

  const lo = p * (1 - zone / 2);
  const hi = p * (1 + zone / 2);
  const stop = long ? p * (1 - sl) : p * (1 + sl);
  const targets = cfg.takeProfitPcts.map((t) => (long ? p * (1 + t / 100) : p * (1 - t / 100)));

  const dec = precisionFor(p, sig.priceRaw);
  const f = (v) => v.toFixed(dec);
  const risk = Math.abs(p - stop);
  const reward = Math.abs((targets[1] ?? targets[0]) - p);

  return {
    signal: sig,
    direction: sig.direction,
    ticker: STABLE_QUOTES.has(sig.quote) ? `$${sig.base}` : `$${sig.base}/${sig.quote}`,
    entryLow: f(lo),
    entryHigh: f(hi),
    stop: f(stop),
    targets: targets.map(f),
    rr: risk ? (reward / risk).toFixed(1) : "-",
    emoji: long ? "🟢" : "🔴",
    arrow: long ? "📈" : "📉",
  };
}

// ---------------------------------------------------------------- templates

function money(v, quote) {
  const unit = STABLE_QUOTES.has(quote) && quote !== "" ? "$" : "";
  const suffix = unit ? "" : ` ${quote}`;
  for (const [div, tag] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (Math.abs(v) >= div) return `${unit}${(v / div).toFixed(2)}${tag}${suffix}`;
  }
  if (Math.abs(v) < 100) return `${unit}${Number(v.toPrecision(4))}${suffix}`;
  return `${unit}${Math.round(v).toLocaleString("en-US")}${suffix}`;
}

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

const signed = (v, d = 2) => `${v > 0 ? "+" : ""}${v.toFixed(d)}%`;

function facts(s) {
  const g = s.signal;
  const sideWord = g.side === "buy" ? "Buy" : "Sell";
  const f = {
    dom: `${Math.round(g.dominance)}%`,
    side_word: sideWord,
    vol: money(g.alertVolume, g.quote),
    window: g.window,
    vol24: money(g.vol24h, g.quote),
    ch24: (g.change["24h"] ?? 0).toFixed(2),
    ch4: (g.change["4h"] ?? 0).toFixed(2),
    n15: g.netVol["15m"],
    n1h: g.netVol["1h"],
    move: signed(g.priceMovePct ?? 0),
    alerts4_txt: plural(g.alerts4h, `${sideWord.toLowerCase()} alert`),
    alerts24_txt: plural(g.alerts24h, "alert"),
  };

  if (g.source === "pumpdetector") {
    const volCh = g.volChangePct == null ? "" : ` (${signed(g.volChangePct, 0)})`;
    f.statLine = `📈 Move ${f.move}  ·  Vol ${f.vol24}${volCh}${g.exchange ? `  ·  ${g.exchange}` : ""}`;
    f.bullets = [
      `Price jumped ${f.move} from $${g.priceFromRaw} to $${g.priceRaw}`,
      g.volChangePct == null ? `Volume at ${f.vol24}` : `Volume up ${signed(g.volChangePct, 0)} to ${f.vol24}`,
      `${money(g.volIncrease, g.quote)} of fresh volume${g.exchange ? ` on ${g.exchange}` : ""}`,
    ];
  } else {
    f.statLine = `📈 24h ${f.ch24}%  ·  4h ${f.ch4}%  ·  Vol ${f.vol24}`;
    const pct = (v) => (v === undefined ? "n/a" : `${v > 0 ? "+" : ""}${Math.round(v)}%`);
    f.bullets = [
      `${f.dom} ${sideWord.toLowerCase()}-side dominance on ${f.vol} in ${f.window}`,
      `Net volume 15m ${pct(f.n15)} · 1h ${pct(f.n1h)}`,
      `${f.vol24} traded in 24h · ${f.alerts24_txt} today`,
    ];
  }
  return f;
}

const LONG_NOTES = [
  (f) => `${f.side_word} orders took ${f.dom} of a ${f.vol} sweep in ${f.window}. Net volume is holding positive, and buyers keep stepping in above support.`,
  (f) => `A ${f.vol} buy-side sweep hit in ${f.window} with ${f.dom} of it on the bid. Momentum is building while the ${f.ch24}% daily trend stays intact.`,
  (f) => `Buyers absorbed the offer with ${f.dom} dominance on ${f.vol} traded in ${f.window}. As long as the entry zone holds, continuation stays on the table.`,
  (f) => `Aggressive accumulation: ${f.dom} of ${f.vol} in ${f.window} came from the buy side. Net volume turned positive on the 15m and 1h.`,
  (f) => `Demand is showing up — ${f.vol} in ${f.window}, ${f.dom} of it buying. Price is defending the level and the higher-timeframe trend is still up.`,
  (f) => `Repeat interest — ${f.alerts4_txt} on this pair in the last 4h, the latest ${f.vol} at ${f.dom} dominance. Clustered demand often precedes expansion.`,
  (f) => `Order flow flipped bullish: ${f.dom} buy-side on ${f.vol} in ${f.window}, against ${f.vol24} of daily turnover. Watching for follow-through.`,
  (f) => `Strength after the pullback. Buyers defended the zone with ${f.vol} of demand in ${f.window} and net volume stayed green.`,
];

const SHORT_NOTES = [
  (f) => `${f.side_word} orders took ${f.dom} of a ${f.vol} dump in ${f.window}. Sellers are in control while price stays under the entry zone.`,
  (f) => `A ${f.vol} sell-side sweep hit in ${f.window}, ${f.dom} of it offered. Supply is heavy and the bounce is being sold.`,
  (f) => `Distribution showing: ${f.dom} of ${f.vol} in ${f.window} came from sellers. Net volume is negative and rallies keep failing.`,
  (f) => `Sellers pressed ${f.vol} through the book in ${f.window} with ${f.dom} dominance. Momentum stays down unless the stop level reclaims.`,
  (f) => `Heavy offer into strength — ${f.vol} in ${f.window}, ${f.dom} selling, against ${f.vol24} of daily volume. Continuation lower is favoured.`,
  (f) => `Persistent supply — ${f.alerts4_txt} on this pair in the last 4h, the latest ${f.vol} at ${f.dom} dominance. It rarely clears in one move.`,
  (f) => `Bearish order flow: ${f.dom} sell-side on ${f.vol} in ${f.window}. Price is losing the level and buyers are not defending it.`,
  (f) => `Rejection from the zone. ${f.vol} of supply in ${f.window} with ${f.dom} on the ask, and net volume rolled over.`,
];

// The pump channel publishes no order-flow data, so it gets its own commentary that
// only claims what the message actually contains.
const PUMP_NOTES = [
  (f) => `Price jumped ${f.move} on ${f.vol24} of volume. Momentum is live — the move is already underway, so the entry zone matters more than usual.`,
  (f) => `Sharp expansion: ${f.move} with volume at ${f.vol24}. Buyers are paying up, and continuation depends on this level holding.`,
  (f) => `Volume-driven breakout, ${f.move} with fresh participation stepping in. Watch for a hold above the entry zone rather than chasing the wick.`,
  (f) => `A ${f.move} impulse backed by real turnover. Strong moves often extend, but late entries carry the most risk — respect the stop.`,
  (f) => `Buyers took control fast: ${f.move} on ${f.vol24}. If price consolidates above the zone instead of fading, continuation is on the table.`,
  (f) => `Fresh volume is driving this ${f.move} move. Interest is clearly picking up, though the first leg has already played out.`,
  (f) => `Breakout in progress — ${f.move} with volume confirming. The zone below is where the move either holds or fails.`,
  (f) => `Momentum ignition: ${f.move}, volume expanding. Treat the entry zone as the line in the sand for this setup.`,
];

const DUMP_NOTES = [
  (f) => `Price broke down ${f.move} on ${f.vol24} of volume. Sellers are in control and bounces are being absorbed.`,
  (f) => `Sharp flush: ${f.move} with volume at ${f.vol24}. Supply is heavy and the level below is now resistance.`,
  (f) => `Volume-driven breakdown, ${f.move}. Momentum is lower while price stays beneath the entry zone.`,
  (f) => `A ${f.move} impulse to the downside backed by real turnover. Late shorts carry the most risk — respect the stop.`,
];

function noteFor(s, seed) {
  const pump = s.signal.source === "pumpdetector";
  const pool = pump
    ? s.direction === "LONG" ? PUMP_NOTES : DUMP_NOTES
    : s.direction === "LONG" ? LONG_NOTES : SHORT_NOTES;
  return pool[seed % pool.length](facts(s));
}

const TEMPLATES = [
  function boxed(s, note) {
    return `◆ *${s.ticker}* (${s.direction}) ${s.emoji}
───────────────────
📍 *Entry Zone* : ${s.entryLow} – ${s.entryHigh}
🛡️ *Stop Loss*  : ${s.stop}

🎯 *Take Profit Targets:*
✦ *TP1* : ${s.targets[0]}
✦ *TP2* : ${s.targets[1]}
✦ *TP3* : ${s.targets[2]}

💡 ${note}
───────────────────
*${s.ticker}*`;
  },
  function plain(s, note) {
    const long = s.direction === "LONG";
    return `${s.ticker} — ${long ? "Breaking above" : "Losing"} ${s.targets[0]} ${long ? "could unlock further upside" : "opens the door to further downside"}.

${long ? "Long" : "Short"} ${s.ticker}

Entry: ${s.entryLow}–${s.entryHigh}
SL: ${s.stop}

TP1: ${s.targets[0]}
TP2: ${s.targets[1]}
TP3: ${s.targets[2]}

${note}

Trade here 👇

${s.ticker}`;
  },
  function rocket(s, note) {
    return `${s.direction === "LONG" ? "🚀" : "⚡"} *${s.ticker} ${s.direction} SETUP* ${s.arrow}🔥

Entry: ${s.entryLow}–${s.entryHigh}

🎯 *Take Profit Targets*
1️⃣ TP1: ${s.targets[0]}
2️⃣ TP2: ${s.targets[1]}
3️⃣ TP3: ${s.targets[2]}

🛡️ SL: ${s.stop}

━━━━━━━━━━━━━━

📊 ${note}

Trade here 👇

${s.ticker}`;
  },
  function headline(s, note) {
    const long = s.direction === "LONG";
    return `🚀 *${s.ticker} — ${long ? "Buyers are defending support, more upside possible" : "Sellers are capping every bounce, more downside possible"}* ${s.arrow}🔥

${long ? "Long" : "Short"} ${s.ticker} ${s.emoji}

Entry: ${s.entryLow}–${s.entryHigh}

🎯 Take Profit:
TP1: ${s.targets[0]}
TP2: ${s.targets[1]}
TP3: ${s.targets[2]}

🛡️ SL: ${s.stop}

${note}

Trade here 👇

${s.ticker}`;
  },
  function card(s, note) {
    const f = facts(s);
    return `╭━━━ *TRADE IDEA* ━━━╮
  ${s.ticker}   ·   *${s.direction}* ${s.emoji}
╰━━━━━━━━━━━━━━━╯

\`Entry \`  ${s.entryLow} – ${s.entryHigh}
\`Stop  \`  ${s.stop}
\`TP1   \`  ${s.targets[0]}
\`TP2   \`  ${s.targets[1]}
\`TP3   \`  ${s.targets[2]}
\`R:R   \`  1 : ${s.rr}

${f.statLine}

${note}

*${s.ticker}*`;
  },
  function checklist(s, note) {
    const f = facts(s);
    return `${s.emoji} *${s.ticker} · ${s.direction}*

*Why this setup:*
${f.bullets.map((b) => `✅ ${b}`).join("\n")}

*The plan:*
📍 Entry  ${s.entryLow} – ${s.entryHigh}
🛡️ Stop   ${s.stop}
🎯 Targets ${s.targets[0]} → ${s.targets[1]} → ${s.targets[2]}
⚖️ R:R    1 : ${s.rr}

${note}

${s.ticker}`;
  },
  function minimal(s, note) {
    return `*${s.direction} ${s.ticker}*

Entry ${s.entryLow} – ${s.entryHigh}
Stop  ${s.stop}
Targets ${s.targets[0]} / ${s.targets[1]} / ${s.targets[2]}
R:R 1:${s.rr}

${note}`;
  },
];

export const TEMPLATE_NAMES = TEMPLATES.map((f) => f.name);

export function render(s, index, seed) {
  return TEMPLATES[index % TEMPLATES.length](s, noteFor(s, seed));
}

// ---------------------------------------------------------------- telegram

async function sendMessage(token, chatId, text) {
  const post = (body) =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  const base = { chat_id: chatId, text, disable_web_page_preview: true };
  let res = await post({ ...base, parse_mode: "Markdown" });
  if (!res.ok && /parse/i.test(res.description || "")) res = await post(base); // retry as plain text
  return res;
}

// ---------------------------------------------------------------- main

async function runOnce(env, { dryRun = false } = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatIds = (env.TELEGRAM_CHAT_ID || "").split(",").map((c) => c.trim()).filter(Boolean);
  const channel = env.SOURCE_CHANNEL || ""; // optional: restrict this run to one channel
  if (!token || !chatIds.length) return { error: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set" };

  const stored = await env.STATE.get("state", { type: "json" });
  const state = stored || { templateIndex: 0, sentTotal: 0, channels: {} };
  if (!state.channels) state.channels = {};
  // migrate the single-source layout that predates the pump channel
  if (state.lastId && state.channels.whaletracker === undefined) state.channels.whaletracker = state.lastId;

  // honour an explicit SOURCE_CHANNEL override, otherwise run every configured source
  const sources = channel ? SOURCES.filter((s) => s.channel === channel) : SOURCES;

  const log = [];
  const perSource = {};
  let sent = 0;
  let changed = false;

  for (const src of sources) {
    const since = state.channels[src.key] || 0;
    let posts;
    try {
      const res = await fetch(`https://t.me/s/${src.channel}`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; whale-signals/1.0)", "Accept-Language": "en" },
      });
      if (!res.ok) {
        log.push(`${src.key}: fetch failed ${res.status}`);
        continue; // one dead source must not stop the other
      }
      posts = extractPosts(await res.text());
    } catch (err) {
      log.push(`${src.key}: fetch threw ${err}`);
      continue;
    }

    const fresh = posts.filter(([id]) => id > since).sort((a, b) => a[0] - b[0]);
    const highest = posts.reduce((m, [id]) => Math.max(m, id), since);
    let sentHere = 0;

    for (const [id, text] of fresh) {
      if (sent >= CONFIG.maxSignalsPerRun) {
        log.push(`${src.key}: per-run cap ${CONFIG.maxSignalsPerRun} reached, rest deferred`);
        break;
      }
      const sig = PARSERS[src.key](text, id);
      if (!sig) continue;
      if (CONFIG.excludeStablecoins && STABLE_BASES.has(sig.base)) continue;
      if (!CONFIG.allowShorts && sig.side === "sell") continue;

      const s = buildSetup(sig, CONFIG);
      const idx = state.templateIndex;
      const out = render(s, idx, id);

      if (dryRun) {
        log.push(`[dry] ${src.key} ${sig.symbol} ${s.direction} via ${TEMPLATE_NAMES[idx % TEMPLATE_NAMES.length]}\n${out}`);
      } else {
        let delivered = 0;
        for (const cid of chatIds) {
          const r = await sendMessage(token, cid, out);
          if (r.ok) delivered += 1;
          else log.push(`send failed ${sig.symbol} -> ${cid}: ${r.description}`);
        }
        if (!delivered) continue;
        log.push(`sent ${src.key} ${sig.symbol} ${s.direction} to ${delivered}/${chatIds.length}`);
      }
      state.templateIndex = idx + 1;
      sent += 1;
      sentHere += 1;
    }

    if (highest !== since || sentHere > 0) {
      state.channels[src.key] = highest;
      changed = true;
    }
    perSource[src.key] = { fetched: posts.length, fresh: fresh.length, sent: sentHere, lastId: highest };
  }

  // Only write KV when something changed -- the free plan allows 1,000 writes/day,
  // and both sources share a single key so one run is at most one write.
  if (changed && !dryRun) {
    delete state.lastId; // superseded by state.channels
    state.sentTotal = (state.sentTotal || 0) + sent;
    await env.STATE.put("state", JSON.stringify(state));
  }

  return { sources: perSource, sent, wroteState: changed && !dryRun, log };
}

export default {
  // Cron Trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOnce(env).then((r) => console.log(JSON.stringify(r))));
  },

  // Manual endpoints for testing:  /run  /dry  /state  /health
  async fetch(request, env) {
    const url = new URL(request.url);
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json" } });

    if (url.pathname === "/health") return json({ ok: true, sources: SOURCES.map((s) => s.channel) });
    if (url.pathname === "/state") return json((await env.STATE.get("state", { type: "json" })) || { channels: {} });
    if (url.pathname === "/dry") return json(await runOnce(env, { dryRun: true }));
    if (url.pathname === "/run") {
      if (env.ADMIN_KEY && url.searchParams.get("key") !== env.ADMIN_KEY) return json({ error: "bad key" }, 403);
      return json(await runOnce(env));
    }
    return json({ endpoints: ["/health", "/state", "/dry", "/run?key=..."] });
  },
};
