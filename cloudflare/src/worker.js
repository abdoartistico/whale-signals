/**
 * WhaleTracker -> Binance Square, on Cloudflare Workers.
 *
 * Reads the public WhaleTracker Telegram channel, turns each volume alert into a
 * trade setup, and publishes it to Binance Square via the Square OpenAPI.
 * Runs on a Cron Trigger every 2 minutes. State lives in Workers KV.
 *
 * Binance Square allows 100 posts/day. WhaleTracker produces ~570 alerts/day, so
 * posting is paced: at most one post per MIN_MINUTES_BETWEEN_POSTS, hard-capped by
 * maxPostsPerDay, always choosing the NEWEST eligible signal in the window. Pacing
 * (rather than posting until the quota dies) keeps coverage spread over 24h.
 *
 * Cloudflare free-plan budget per invocation: 50 subrequests, 10ms CPU.
 */

const CONFIG = {
  // Entry runs from slightly below the alert price UP TO the alert price.
  entryZonePct: 0.4,
  // Stop loss and targets are measured from the MIDPOINT of the entry range.
  stopLossPct: 7.0,
  takeProfitPcts: [4.0, 8.0, 12.0],

  excludeStablecoins: true,
  allowShorts: true,
  usdtPairsOnly: true,

  // Binance Square limits: 100 posts/day. Stay under it with margin.
  maxPostsPerDay: 95,
  minMinutesBetweenPosts: 15, // 15 min => at most 96/day, so the cap cannot be hit
  postToBinanceSquare: true,
  // Telegram is no longer a destination -- it receives a confirmation with the
  // Binance post link after each successful publish, so you can verify it landed.
  telegramConfirm: true,
};

const SOURCES = [{ key: "whaletracker", channel: "WhaleTracker" }];

// Pegged assets: a 12% target on a $1.00 coin is not a trade.
const STABLE_BASES = new Set([
  "USDT", "USDC", "FDUSD", "TUSD", "USDP", "USDD", "DAI", "EURI", "EURT", "AEUR",
  "PYUSD", "GUSD", "FRAX", "LUSD", "SUSD", "MUSD", "USDX", "CEUR", "XSGD", "TRYB", "BRLZ",
  // kept from before
  "RLUSD", "BUSD", "USDE", "USD1", "USDS", "CRVUSD", "USDG", "USDY", "EURS",
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
  const long = sig.side === "buy";

  // Entry range: from slightly below the alert price up to the alert price itself.
  const lo = p * (1 - cfg.entryZonePct / 100);
  const hi = p;
  const mid = (lo + hi) / 2;

  // Stop and targets are both measured from the entry midpoint.
  const sl = cfg.stopLossPct / 100;
  const stop = long ? mid * (1 - sl) : mid * (1 + sl);
  const targets = cfg.takeProfitPcts.map((t) => (long ? mid * (1 + t / 100) : mid * (1 - t / 100)));

  const dec = precisionFor(p, sig.priceRaw);
  const f = (v) => withCommas(v.toFixed(dec));
  const risk = Math.abs(mid - stop);
  const reward = Math.abs((targets[1] ?? targets[0]) - mid);

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
  };
}
// ---------------------------------------------------------------- post text
//
// One fixed structure, exactly as specified:
//
//   $SYMBOL — <header>
//
//   Entry: <low> - <high>
//   SL: <sl>
//
//   TP1: <t1>
//   TP2: <t2>
//   TP3: <t3>
//
//   <short description>
//
//   Trade here 👇
//   $SYMBOL
//
// The header and the description rotate. Descriptions also interpolate the real
// order-flow numbers from the alert, so two posts about different coins never read
// alike even when they draw the same phrasing.

const LONG_HEADERS = [
  "LONG setup big long now, big profit soon🤑",
  "LONG setup momentum accelerating fast, massive gains incoming🚀",
  "LONG setup breakout confirmed, ready to smash targets🔥",
  "LONG setup buyers taking over, upside opening up💪",
  "LONG setup demand surging, targets in sight🎯",
  "LONG setup strong bid stepping in, move loading⚡",
  "LONG setup volume exploding, rally starting🚀",
  "LONG setup bulls in control, profit window open🤑",
  "LONG setup accumulation done, expansion next📈",
  "LONG setup pressure building fast, big candles coming🔥",
  "LONG setup support holding firm, upside unlocked💎",
  "LONG setup order flow flipping bullish, ride it📈",
  "LONG setup dip bought hard, reversal confirmed💪",
  "LONG setup buyers dominating the tape, targets ahead🎯",
  "LONG setup momentum igniting, do not miss this🚀",
  "LONG setup breakout in motion, profit soon🤑",
  "LONG setup heavy buying detected, move starting⚡",
  "LONG setup trend turning up, targets loading📈",
  "LONG setup strength returning fast, upside ready🔥",
  "LONG setup bids stacking up, squeeze potential💥",
  "LONG setup fresh demand entering, rally forming🚀",
  "LONG setup sellers exhausted, buyers stepping in💪",
  "LONG setup clean entry forming, targets locked🎯",
  "LONG setup big money buying, follow the flow💎",
];

const SHORT_HEADERS = [
  "SHORT setup big drop now, big profit soon📉",
  "SHORT setup breakdown confirmed, targets below🔻",
  "SHORT setup sellers taking over, downside opening📉",
  "SHORT setup supply flooding in, dump loading⚡",
  "SHORT setup momentum turning down, profit soon💰",
  "SHORT setup resistance rejected, fall incoming🔻",
  "SHORT setup heavy selling detected, move starting📉",
  "SHORT setup bears in control, targets ahead🎯",
  "SHORT setup distribution done, breakdown next📉",
  "SHORT setup pressure building down, red candles coming🔻",
  "SHORT setup bounce sold hard, reversal confirmed📉",
  "SHORT setup sellers dominating the tape, downside ready💰",
  "SHORT setup trend turning down, targets loading🔻",
  "SHORT setup weakness spreading fast, drop ready📉",
  "SHORT setup asks stacking up, flush potential💥",
  "SHORT setup fresh supply entering, dump forming🔻",
  "SHORT setup buyers exhausted, sellers stepping in📉",
  "SHORT setup clean short forming, targets locked🎯",
  "SHORT setup big money selling, follow the flow💰",
  "SHORT setup order flow flipping bearish, ride it🔻",
  "SHORT setup support broken, downside unlocked📉",
  "SHORT setup rally faded fast, short window open💰",
  "SHORT setup volume exploding down, slide starting⚡",
  "SHORT setup momentum collapsing, do not miss this🔻",
];

function money(v) {
  for (const [div, tag] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (Math.abs(v) >= div) return `$${(v / div).toFixed(2)}${tag}`;
  }
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

function facts(s) {
  const g = s.signal;
  return {
    dom: `${Math.round(g.dominance)}%`,
    vol: money(g.alertVolume),
    vol24: money(g.vol24h),
    window: g.window || "the last minute",
    ch24: `${(g.change["24h"] ?? 0) > 0 ? "+" : ""}${(g.change["24h"] ?? 0).toFixed(2)}%`,
    n15: g.netVol["15m"],
    n1h: g.netVol["1h"],
    alerts24: g.alerts24h,
  };
}

const LONG_DESCS = [
  (f) => `Order book is leaning hard to the bid: ${f.dom} of ${f.vol} traded in ${f.window} was buying.`,
  (f) => `Momentum check — ${f.vol} of demand in ${f.window} against ${f.vol24} daily turnover.`,
  (f) => `Buyers absorbed the offers with ${f.dom} dominance, and the pair is ${f.ch24} on the day.`,
  (f) => `Fresh bid stepping in: ${f.vol} bought in ${f.window} while net volume stays positive.`,
  (f) => `Tape reads bullish — ${f.dom} buy-side pressure on ${f.vol24} of 24h volume.`,
  (f) => `Accumulation showing up in the flow, ${f.vol} lifted in ${f.window} without much resistance.`,
  (f) => `Liquidity is being taken on the ask side, ${f.dom} of the last burst was buying.`,
  (f) => `Demand outpacing supply here: ${f.vol} in ${f.window}, day change ${f.ch24}.`,
  (f) => `Volume profile is tilting up, with ${f.dom} of ${f.vol} hitting the offer.`,
  (f) => `Buy-side aggression detected — ${f.vol} in ${f.window} on ${f.vol24} daily turnover.`,
  (f) => `Order flow flipped: ${f.dom} buying pressure and this is alert ${f.alerts24} today.`,
  (f) => `Strong bid defending the level, ${f.vol} absorbed in ${f.window}.`,
  (f) => `Fundamentals aside, the tape is doing the talking: ${f.dom} of ${f.vol} was buying.`,
  (f) => `Participation picking up fast, ${f.vol24} traded in 24h and the pair sits ${f.ch24}.`,
  (f) => `Sellers stepping aside as ${f.vol} of demand cleared the book in ${f.window}.`,
  (f) => `Buying interest concentrated here — ${f.dom} dominance and rising net volume.`,
  (f) => `Real money on the bid: ${f.vol} in ${f.window}, well above the usual pace.`,
  (f) => `Book is thin above and buyers are lifting it, ${f.dom} of the flow was aggressive.`,
  (f) => `Bullish imbalance building, ${f.vol} bought against ${f.vol24} of daily volume.`,
  (f) => `Repeat interest — ${f.alerts24} alerts today, latest ${f.vol} at ${f.dom} buy dominance.`,
];

const SHORT_DESCS = [
  (f) => `Order book is leaning hard to the ask: ${f.dom} of ${f.vol} traded in ${f.window} was selling.`,
  (f) => `Momentum check — ${f.vol} of supply in ${f.window} against ${f.vol24} daily turnover.`,
  (f) => `Sellers hit the bids with ${f.dom} dominance, and the pair is ${f.ch24} on the day.`,
  (f) => `Fresh supply stepping in: ${f.vol} sold in ${f.window} while net volume stays negative.`,
  (f) => `Tape reads bearish — ${f.dom} sell-side pressure on ${f.vol24} of 24h volume.`,
  (f) => `Distribution showing up in the flow, ${f.vol} dumped in ${f.window} with weak bids.`,
  (f) => `Liquidity is being taken on the bid side, ${f.dom} of the last burst was selling.`,
  (f) => `Supply outpacing demand here: ${f.vol} in ${f.window}, day change ${f.ch24}.`,
  (f) => `Volume profile is tilting down, with ${f.dom} of ${f.vol} hitting the bid.`,
  (f) => `Sell-side aggression detected — ${f.vol} in ${f.window} on ${f.vol24} daily turnover.`,
  (f) => `Order flow flipped: ${f.dom} selling pressure and this is alert ${f.alerts24} today.`,
  (f) => `Bids getting pulled as ${f.vol} of supply cleared the book in ${f.window}.`,
  (f) => `Fundamentals aside, the tape is doing the talking: ${f.dom} of ${f.vol} was selling.`,
  (f) => `Participation picking up fast, ${f.vol24} traded in 24h and the pair sits ${f.ch24}.`,
  (f) => `Buyers stepping aside while ${f.vol} of supply pressured the book in ${f.window}.`,
  (f) => `Selling interest concentrated here — ${f.dom} dominance and falling net volume.`,
  (f) => `Real size on the offer: ${f.vol} in ${f.window}, well above the usual pace.`,
  (f) => `Book is thin below and sellers are pressing it, ${f.dom} of the flow was aggressive.`,
  (f) => `Bearish imbalance building, ${f.vol} sold against ${f.vol24} of daily volume.`,
  (f) => `Persistent supply — ${f.alerts24} alerts today, latest ${f.vol} at ${f.dom} sell dominance.`,
];

/**
 * Integer hash so each rotating slot is drawn independently.
 * A linear stride (seed * salt) makes the slots move in lockstep, which collapses the
 * variety to the pool length; hashing keeps header and description uncorrelated.
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

export function render(s, seed) {
  const long = s.direction === "LONG";
  const header = pick(long ? LONG_HEADERS : SHORT_HEADERS, seed, 1);
  const desc = pick(long ? LONG_DESCS : SHORT_DESCS, seed, 7)(facts(s));

  return `${s.ticker} — ${header}

Entry: ${s.entryLow} - ${s.entryHigh}
SL: ${s.stop}

TP1: ${s.targets[0]}
TP2: ${s.targets[1]}
TP3: ${s.targets[2]}

${desc}

Trade here 👇
${s.ticker}`;
}
// ---------------------------------------------------------------- publishing

const SQUARE_URL = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

/**
 * Publish a short text post to Binance Square.
 * Schema and semantics mirror Binance's own square-post client:
 *   POST /content/add  { contentType: 1, bodyTextOnly }
 *   success when code === "000000"; a 504 on this endpoint means the post landed
 *   but the id could not be returned, so it must NOT be retried.
 */
export async function postToSquare(apiKey, text) {
  let res;
  try {
    res = await fetch(SQUARE_URL, {
      method: "POST",
      headers: {
        "X-Square-OpenAPI-Key": apiKey,
        "Content-Type": "application/json",
        clienttype: "binanceSkill",
      },
      body: JSON.stringify({ contentType: 1, bodyTextOnly: text }),
    });
  } catch (err) {
    return { ok: false, error: `network: ${err}` };
  }

  // Documented by Binance: treat as published, do not retry or it double-posts.
  if (res.status === 504) return { ok: true, id: null, note: "success_without_post_id" };

  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: `non-JSON ${res.status}: ${raw.slice(0, 160)}` };
  }
  if (json.code !== "000000") return { ok: false, error: `[${json.code}] ${json.message}`, code: json.code };
  return { ok: true, id: json.data?.id ?? null, link: json.data?.shareLink ?? null };
}

/** Telegram is used only to confirm a Square post landed, with its link. */
export function confirmationText(s, result, quota) {
  const link = result.link
    ? result.link
    : result.note === "success_without_post_id"
      ? "(published, but Binance returned no link for this one)"
      : "(link unavailable)";
  return `✅ Posted to Binance Square

${s.ticker} — ${s.direction}
Entry: ${s.entryLow} - ${s.entryHigh}
SL: ${s.stop}
TP: ${s.targets.join(" / ")}

${link}

Post ${quota.used}/${quota.cap} today`;
}

async function sendTelegram(token, chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return res.json();
}
// ---------------------------------------------------------------- main

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Reset the daily counter when the UTC date rolls over (Binance quotas reset 00:00 UTC). */
function rollQuota(state, nowMs) {
  const today = utcDay(nowMs);
  if (!state.quota || state.quota.date !== today) {
    state.quota = { date: today, count: 0, lastPostMs: state.quota?.lastPostMs || 0 };
    return true;
  }
  return false;
}

async function runOnce(env, { dryRun = false, force = false } = {}) {
  const squareKey = env.BINANCE_SQUARE_KEY || "";
  const tgToken = env.TELEGRAM_BOT_TOKEN || "";
  const tgChats = (env.TELEGRAM_CHAT_ID || "").split(",").map((c) => c.trim()).filter(Boolean);

  if (CONFIG.postToBinanceSquare && !squareKey && !dryRun) {
    return { error: "BINANCE_SQUARE_KEY is not set" };
  }

  const nowMs = Date.now();
  const stored = await env.STATE.get("state", { type: "json" });
  const state = stored || { templateIndex: 0, sentTotal: 0, channels: {} };
  if (!state.channels) state.channels = {};
  if (state.lastId && state.channels.whaletracker === undefined) state.channels.whaletracker = state.lastId;
  const rolled = rollQuota(state, nowMs);

  const log = [];
  const perSource = {};
  let posted = 0;
  let changed = rolled;

  for (const src of SOURCES) {
    const since = state.channels[src.key] || 0;
    let posts;
    try {
      const res = await fetch(`https://t.me/s/${src.channel}`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; whale-signals/1.0)", "Accept-Language": "en" },
      });
      if (!res.ok) {
        log.push(`${src.key}: fetch failed ${res.status}`);
        continue;
      }
      posts = extractPosts(await res.text());
    } catch (err) {
      log.push(`${src.key}: fetch threw ${err}`);
      continue;
    }

    const fresh = posts.filter(([id]) => id > since).sort((a, b) => a[0] - b[0]);
    const highest = posts.reduce((m, [id]) => Math.max(m, id), since);

    // Everything that survives the coin filter, newest last.
    const eligible = [];
    for (const [id, text] of fresh) {
      const sig = PARSERS[src.key](text, id);
      if (!sig) continue;
      if (CONFIG.usdtPairsOnly && !STABLE_QUOTES.has(sig.quote)) continue;
      if (CONFIG.excludeStablecoins && STABLE_BASES.has(sig.base)) continue;
      if (!CONFIG.allowShorts && sig.side === "sell") continue;
      eligible.push(sig);
    }

    perSource[src.key] = { fetched: posts.length, fresh: fresh.length, eligible: eligible.length, lastId: highest };

    // Rate gates. Binance allows 100 posts/day; we pace instead of burning the quota
    // in the first hours, and we publish the NEWEST eligible signal in the window.
    const sinceLastMin = (nowMs - (state.quota.lastPostMs || 0)) / 60000;
    const quotaLeft = CONFIG.maxPostsPerDay - state.quota.count;

    if (eligible.length === 0) {
      if (fresh.length) log.push(`${src.key}: ${fresh.length} fresh, none eligible after coin filter`);
    } else if (quotaLeft <= 0 && !force) {
      log.push(`daily cap reached (${state.quota.count}/${CONFIG.maxPostsPerDay}), waiting for UTC reset`);
    } else if (sinceLastMin < CONFIG.minMinutesBetweenPosts && !force) {
      log.push(`pacing: ${(CONFIG.minMinutesBetweenPosts - sinceLastMin).toFixed(1)} min until next post`);
    } else {
      const sig = eligible[eligible.length - 1]; // newest is the most tradable
      const s = buildSetup(sig, CONFIG);
      const text = render(s, sig.msgId);

      if (dryRun) {
        log.push(`[dry] ${sig.symbol} ${s.direction} (${eligible.length} eligible, posting newest)\n${text}`);
      } else {
        const r = await postToSquare(squareKey, text);
        if (!r.ok) {
          log.push(`square: FAILED ${sig.symbol}: ${r.error}`);
        } else {
          log.push(`square: posted ${sig.symbol} ${s.direction}${r.link ? ` ${r.link}` : ""}${r.note ? ` (${r.note})` : ""}`);
          state.quota.count += 1;
          state.quota.lastPostMs = nowMs;
          state.sentTotal = (state.sentTotal || 0) + 1;
          posted += 1;

          // Confirm to Telegram with the link. A failure here must NOT affect the
          // post -- it is already live on Square and must never be republished.
          if (CONFIG.telegramConfirm && tgToken) {
            const note = confirmationText(s, r, { used: state.quota.count, cap: CONFIG.maxPostsPerDay });
            for (const cid of tgChats) {
              try {
                const tr = await sendTelegram(tgToken, cid, note);
                if (!tr.ok) log.push(`telegram confirm failed ${cid}: ${tr.description}`);
              } catch (err) {
                log.push(`telegram confirm threw ${cid}: ${err}`);
              }
            }
          }
        }
      }
    }

    if (highest !== since) {
      // Advance past everything seen, posted or not -- skipped alerts are stale by the
      // next window and must not queue up behind the rate limit.
      state.channels[src.key] = highest;
      changed = true;
    }
  }

  if ((changed || posted) && !dryRun) {
    delete state.lastId;
    await env.STATE.put("state", JSON.stringify(state));
  }

  return {
    sources: perSource,
    posted,
    quota: { used: state.quota.count, cap: CONFIG.maxPostsPerDay, date: state.quota.date },
    log,
  };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runOnce(env).then((r) => console.log(JSON.stringify(r))));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o, null, 2), { status, headers: { "content-type": "application/json" } });

    if (url.pathname === "/health")
      return json({ ok: true, sources: SOURCES.map((s) => s.channel), destination: CONFIG.postToBinanceSquare ? "binance-square" : "telegram" });
    if (url.pathname === "/state") return json((await env.STATE.get("state", { type: "json" })) || { channels: {} });
    if (url.pathname === "/probe") {
      // Diagnostic: can this Worker reach Binance at all? Uses the auth-only image
      // endpoint so nothing is ever published.
      const r = await fetch("https://www.binance.com/bapi/composite/v2/public/pgc/openApi/image/presignedUrl", {
        method: "POST",
        headers: {
          "X-Square-OpenAPI-Key": env.BINANCE_SQUARE_KEY || "",
          "Content-Type": "application/json",
          clienttype: "binanceSkill",
        },
        body: JSON.stringify({ imageName: "probe.png" }),
      });
      const body = (await r.text()).slice(0, 300);
      return json({
        status: r.status,
        colo: request.cf?.colo ?? null,
        country: request.cf?.country ?? null,
        cfRay: r.headers.get("cf-ray"),
        body,
      });
    }
    if (url.pathname === "/dry") return json(await runOnce(env, { dryRun: true }));
    if (url.pathname === "/run") {
      if (env.ADMIN_KEY && url.searchParams.get("key") !== env.ADMIN_KEY) return json({ error: "bad key" }, 403);
      return json(await runOnce(env, { force: url.searchParams.get("force") === "1" }));
    }
    return json({ endpoints: ["/health", "/state", "/dry", "/run?key=...&force=1"] });
  },
};
