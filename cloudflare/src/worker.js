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
// Only WhaleTracker is active. The pump parser below is kept and tested but dormant --
// re-enable by adding { key: "pumpdetector", channel: "cointrendz_pumpdetector" } here.
const SOURCES = [{ key: "whaletracker", channel: "WhaleTracker" }];

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

/** 1905.5 -> "1,905.5" -- thousands separators on the integer part only. */
function withCommas(s) {
  const [int, frac] = s.split(".");
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (frac ? `.${frac}` : "");
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
  const f = (v) => withCommas(v.toFixed(dec));
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
//
// Three layouts. Each pulls its wording from rotating pools so consecutive posts
// never read the same: an opener/hook, a closing sentiment line, a call to action,
// and (for the SETUP layout) a follow line.
//
// 3 layouts x 24 openers x 24 closers x 6 CTAs = ~10k combinations before repeating.
// Selection is seeded off the message id -- deterministic, but decorrelated per slot
// so the parts don't advance in lockstep.
//
// Plain text on purpose: no Markdown markers, so no parse failures on odd tickers.

const LONG_OPENERS = [
  "Strong buying pressure is increasing.",
  "Momentum is building above support.",
  "Buyers are stepping in with size.",
  "Demand is picking up fast.",
  "Accumulation is showing on the tape.",
  "Buying volume is expanding.",
  "Bulls are taking control here.",
  "Support is holding firm.",
  "Order flow has flipped bullish.",
  "Buyers are defending this zone.",
  "Upside pressure is building.",
  "A breakout attempt is developing.",
  "Volume is confirming the move up.",
  "Dips are being bought aggressively.",
  "Strength is returning after the pullback.",
  "Bullish momentum is accelerating.",
  "Buyers are absorbing the offers.",
  "Interest is rotating into this pair.",
  "The trend is turning up.",
  "Fresh demand is entering the market.",
  "Price is coiling for a move higher.",
  "Sellers are running out of steam.",
  "Higher lows are forming.",
  "Continuation looks likely from here.",
];

const SHORT_OPENERS = [
  "Strong selling pressure is increasing.",
  "Momentum is breaking down below resistance.",
  "Sellers are stepping in with size.",
  "Supply is picking up fast.",
  "Distribution is showing on the tape.",
  "Selling volume is expanding.",
  "Bears are taking control here.",
  "Resistance is capping every bounce.",
  "Order flow has flipped bearish.",
  "Sellers are defending this zone.",
  "Downside pressure is building.",
  "A breakdown is developing.",
  "Volume is confirming the move down.",
  "Rallies are being sold aggressively.",
  "Weakness is returning after the bounce.",
  "Bearish momentum is accelerating.",
  "Sellers are hitting the bids.",
  "Money is rotating out of this pair.",
  "The trend is turning down.",
  "Fresh supply is entering the market.",
  "Price is rolling over.",
  "Buyers are running out of steam.",
  "Lower highs are forming.",
  "Continuation lower looks likely from here.",
];

const LONG_CLOSERS = [
  "Buying interest remains strong, keeping the bullish trend intact as long as support holds. 📈",
  "Buyers are defending key levels and momentum stays positive while this zone holds.",
  "Price is showing strength after the recent dip, with buyers active on every pullback.",
  "As long as the entry zone holds, continuation toward the targets stays on the table. 📈",
  "Demand is outpacing supply here, and the structure stays bullish above the stop.",
  "Momentum favours the upside while price holds above support. 🚀",
  "Accumulation continues and dips keep getting absorbed by buyers.",
  "The bullish structure remains valid unless the stop level gives way.",
  "Buyers are in control and the path of least resistance points higher. 📈",
  "Strength is building steadily, and a push toward the targets looks reasonable.",
  "Support has held cleanly, which keeps the upside scenario alive.",
  "Volume is backing the move, suggesting real interest rather than a fake push.",
  "The setup stays valid while price consolidates above the entry zone.",
  "Buyers keep defending, and a continuation move is possible if this level holds. 📈",
  "Pressure is on the upside, with sellers struggling to push price lower.",
  "Trend and momentum are aligned to the upside for now. 🚀",
  "Interest is picking up and the reaction off support has been strong.",
  "This zone has attracted consistent buying, keeping the bias bullish.",
  "A hold above the entry zone keeps the targets in play.",
  "Bulls remain in charge while the stop level stays untouched. 📈",
  "The pullback looks corrective, with the larger move still pointing up.",
  "Buyers are absorbing supply, which often precedes an expansion higher.",
  "Momentum remains constructive as long as the structure holds.",
  "Risk stays defined at the stop while the upside targets remain open. 📈",
];

const SHORT_CLOSERS = [
  "Selling interest remains strong, keeping the bearish trend intact as long as resistance holds. 📉",
  "Sellers are defending key levels and momentum stays negative while this zone caps price.",
  "Price is showing weakness after the recent bounce, with sellers active on every rally.",
  "As long as price stays under the entry zone, continuation toward the targets stays on the table. 📉",
  "Supply is outpacing demand here, and the structure stays bearish below the stop.",
  "Momentum favours the downside while price holds below resistance. 🔻",
  "Distribution continues and rallies keep getting sold.",
  "The bearish structure remains valid unless the stop level is reclaimed.",
  "Sellers are in control and the path of least resistance points lower. 📉",
  "Weakness is building steadily, and a push toward the targets looks reasonable.",
  "Resistance has held cleanly, which keeps the downside scenario alive.",
  "Volume is backing the move, suggesting real selling rather than a shakeout.",
  "The setup stays valid while price consolidates below the entry zone.",
  "Sellers keep pressing, and a continuation move is possible if this level caps price. 📉",
  "Pressure is on the downside, with buyers struggling to lift price.",
  "Trend and momentum are aligned to the downside for now. 🔻",
  "Selling is picking up and the rejection from resistance has been clean.",
  "This zone has attracted consistent selling, keeping the bias bearish.",
  "Staying below the entry zone keeps the targets in play.",
  "Bears remain in charge while the stop level holds. 📉",
  "The bounce looks corrective, with the larger move still pointing down.",
  "Sellers are absorbing bids, which often precedes an expansion lower.",
  "Momentum remains weak as long as the structure holds.",
  "Risk stays defined at the stop while the downside targets remain open. 📉",
];

const CTAS = [
  "Open your trade 👇",
  "Trade from here 👇",
  "Trade here 👇",
  "Enter from here 👇",
  "Take the setup here 👇",
  "Start your trade 👇",
];

const FOLLOW_LINES = [
  "✅ Follow for more high-quality trade setups.",
  "✅ Follow for more setups like this.",
  "✅ More high-quality setups posted daily.",
  "✅ Stay tuned for more premium setups.",
];

/**
 * Integer hash, so each slot is picked independently of the others.
 *
 * A linear stride (seed * salt) looks varied but makes the slots move in lockstep:
 * the whole message then repeats with a period equal to the pool size. Hashing gives
 * each slot an effectively independent draw, so combinations run into the thousands.
 */
function hash32(x) {
  x = (x ^ 61) ^ (x >>> 16);
  x = x + (x << 3);
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return x >>> 0;
}

const pick = (pool, seed, salt) => pool[hash32(Math.imul(seed, 0x9e3779b1) + Math.imul(salt, 0x85ebca6b)) % pool.length];

function parts(s, seed) {
  const long = s.direction === "LONG";
  return {
    opener: pick(long ? LONG_OPENERS : SHORT_OPENERS, seed, 1),
    closer: pick(long ? LONG_CLOSERS : SHORT_CLOSERS, seed, 7),
    cta: pick(CTAS, seed, 13),
    follow: pick(FOLLOW_LINES, seed, 5),
  };
}

const TEMPLATES = [
  function setup(s, p) {
    return `🔥 ${s.direction} SETUP — ${s.ticker}

💎 ${p.opener}

Entry Zone: ${s.entryLow} – ${s.entryHigh}

🛡️ Stop Loss: ${s.stop}

🎯 Take Profit:
 TP1: ${s.targets[0]}
 TP2: ${s.targets[1]}
 TP3: ${s.targets[2]}

${p.follow}

${p.cta}

${s.ticker}`;
  },

  function compact(s, p) {
    return `${s.ticker} — ${s.direction} ${s.emoji}
Entry: ${s.entryLow} – ${s.entryHigh}
SL: ${s.stop}
TP1: ${s.targets[0]}
TP2: ${s.targets[1]}
TP3: ${s.targets[2]}
${p.closer}
${p.cta}
${s.ticker}`;
  },

  function hook(s, p) {
    return `${s.ticker} – ${p.opener}
${s.direction === "LONG" ? "Long" : "Short"} ${s.ticker}
Entry: ${s.entryLow} – ${s.entryHigh}
SL: ${s.stop}
TP1: ${s.targets[0]}
TP2: ${s.targets[1]}
TP3: ${s.targets[2]}
${p.closer}
${p.cta}
${s.ticker}`;
  },
];

export const TEMPLATE_NAMES = TEMPLATES.map((f) => f.name);

export function render(s, index, seed) {
  return TEMPLATES[index % TEMPLATES.length](s, parts(s, seed));
}
// ---------------------------------------------------------------- telegram

async function sendMessage(token, chatId, text) {
  const post = (body) =>
    fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());

  // Templates are plain text, so no parse_mode: nothing to mis-parse on odd tickers.
  return post({ chat_id: chatId, text, disable_web_page_preview: true });
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
