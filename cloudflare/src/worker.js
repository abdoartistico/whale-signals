/**
 * CycloneRSI -> Binance Square, on Cloudflare Workers.
 *
 * Reads the public CycloneRSI Telegram channel (RSI overbought/oversold alerts, each
 * with a chart image), turns each into a trade setup, and publishes it to Binance
 * Square with the chart attached. Cron every 2 minutes; state in Workers KV.
 *
 * Direction follows the standard mean-reversion reading of RSI:
 *   Overbought -> SHORT, Oversold -> LONG.
 * Note the channel is heavily skewed to overbought, so most posts are shorts.
 *
 * Binance Square allows 100 posts/day and 400 uploads/day; the channel produces
 * ~870 alerts/day. Posting is therefore paced at one per minMinutesBetweenPosts,
 * hard-capped by maxPostsPerDay, always taking the NEWEST eligible signal in the
 * window so coverage stays spread across 24h instead of dying by breakfast.
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
  // Publishing goes through the GitHub Action (see publishing section for why).
  // Telegram receives a confirmation with the Binance post link from that Action.
};

// WhaleTracker and the pump channel are kept and still parsed by tests, but dormant.
const SOURCES = [{ key: "cyclonersi", channel: "CycloneRSI" }];

// Excluded assets: pegged coins, fiat tokens, gold-backed (PAXG/XAUT) and PEPE,
// all as requested. Symbols are matched uppercase against the parsed base.
const STABLE_BASES = new Set([
  "USDT", "USDC", "BFUSD", "XUSD", "U", "FDUSD", "TUSD", "DAI", "USDP", "PYUSD", "USDD", "USDE",
  "GUSD", "FRAX", "LUSD", "SUSD", "ALUSD", "USDTB", "EURT", "EURS", "BRL", "BRLZ", "BUSD",
  "CADC", "NZDS", "TRYB", "GYEN", "JPYC", "XSGD", "EURL", "EURCV", "VEUR", "CNHT", "MIM",
  "CRVUSD", "DOLA", "HUSD", "OUSD", "USDX", "USN", "VAI", "STBL", "CUSD", "DJED", "AGEUR",
  "EEUR", "CEUR", "SEURO", "PAR", "MUSD", "EUSD", "TOR", "FEI", "USDV", "BOLD", "GRAI",
  "PRISMA", "USH", "YUSD", "ZUSD", "USDS", "USD0", "HYUSD", "MIMA", "BRLA", "ARS", "TRYG",
  "ZARV", "NGNV", "MXNT", "UAHC", "CNH", "IDRT", "PAXG", "XAUT", "PEPE", "RLUSD", "AEUR",
  "EURI", "USD1", "USDG", "USDY"
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
 * Pull [id, text, imageUrl] triples out of the public web preview.
 *
 * Splits on the per-message marker so a photo can never be paired with the wrong
 * message, and matches the photo wrapper specifically -- a bare background-image
 * regex also picks up author avatars.
 */
export function extractPosts(html) {
  const out = [];
  const parts = html.split('data-post="');
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    const id = parseInt(p.slice(0, p.indexOf('"')).split("/").pop(), 10);
    if (!id) continue;

    let text = "";
    const tAt = p.indexOf("js-message_text");
    if (tAt !== -1) {
      const open = p.indexOf(">", tAt);
      const close = p.indexOf("</div>", open);
      text = stripHtml(p.slice(open + 1, close === -1 ? undefined : close));
    }

    let image = null;
    const wAt = p.indexOf("tgme_widget_message_photo_wrap");
    if (wAt !== -1) {
      const m = /background-image:url\('([^']+)'\)/.exec(p.slice(wAt, wAt + 800));
      if (m) image = m[1];
    }

    out.push([id, text, image]);
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

/**
 * CycloneRSI format (every post carries a chart image):
 *
 *   $KERNEL/USDT (30m) Overbought level reached
 *   Price: 0.0508 | RSI: 70.85 | Binance | TV
 *
 * Direction follows the standard mean-reversion reading of RSI:
 *   Overbought / Extreme Overbought -> SHORT   (stretched up, fade it)
 *   Oversold   / Extreme Oversold   -> LONG    (stretched down, buy it)
 */
const RE_CY_HEAD = /\$?([A-Z0-9]+)\/([A-Z]+)\s*\(([^)]+)\)\s*(Extreme\s+)?(Overbought|Oversold)\s+level reached/i;
const RE_CY_PRICE = /Price:\s*([\d.,]+)/;
const RE_CY_RSI = /RSI:\s*([\d.,]+)/;
const RE_CY_EXCH = /\|\s*([A-Za-z]+)\s*\|/;

export function parseCycloneRSI(text, msgId) {
  const head = text.match(RE_CY_HEAD);
  if (!head) return null;
  const price = text.match(RE_CY_PRICE);
  if (!price) return null;

  const sig = {
    msgId,
    source: "cyclonersi",
    base: head[1].toUpperCase(),
    quote: head[2].toUpperCase(),
    timeframe: head[3].trim(),
    extreme: Boolean(head[4]),
    condition: (head[4] ? "Extreme " : "") + head[5],
  };
  sig.symbol = sig.base + sig.quote;
  sig.priceRaw = price[1].replace(/,/g, "");
  sig.price = toNumber(price[1]) || 0;
  if (sig.price <= 0) return null;

  const rsi = text.match(RE_CY_RSI);
  sig.rsi = rsi ? toNumber(rsi[1]) : null;
  const ex = text.match(RE_CY_EXCH);
  sig.exchange = ex ? ex[1] : "";

  // Overbought is a fade, oversold is a bounce.
  const overbought = /Overbought/i.test(head[5]);
  sig.side = overbought ? "sell" : "buy";
  sig.direction = overbought ? "SHORT" : "LONG";

  // fields the shared setup/render path expects
  sig.alertVolume = 0;
  sig.window = sig.timeframe;
  sig.change = {};
  sig.netVol = {};
  sig.vol24h = 0;
  sig.alerts24h = 0;
  sig.alerts4h = 0;
  sig.dominance = 0;
  return sig;
}

export const PARSERS = { whaletracker: parseMessage, pumpdetector: parsePumpDetector, cyclonersi: parseCycloneRSI };

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
    rsi: g.rsi == null ? "" : g.rsi.toFixed(2),
    tf: g.timeframe || "",
    exch: g.exchange || "Binance",
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

// CycloneRSI publishes an RSI reading and a timeframe -- and no order-flow data --
// so it gets its own descriptions. Claiming volume dominance here would be invented.
const RSI_SHORT_DESCS = [
  (f) => `RSI pushed to ${f.rsi} on the ${f.tf} chart, stretched into overbought territory where pullbacks usually begin.`,
  (f) => `Momentum is overextended: ${f.tf} RSI at ${f.rsi}. Buyers are running thin up here.`,
  (f) => `Overbought on the ${f.tf} with RSI ${f.rsi} — the kind of reading that tends to cool off before it continues.`,
  (f) => `${f.tf} RSI at ${f.rsi}. Price has run hot and mean reversion is the higher-probability path.`,
  (f) => `Stretched to the upside — RSI ${f.rsi} on the ${f.tf}. Watching for the fade back toward balance.`,
  (f) => `${f.tf} RSI printed ${f.rsi}, deep in overbought. Late buyers are usually the ones who pay for this.`,
  (f) => `Overbought signal on ${f.exch}: ${f.tf} RSI ${f.rsi}. Risk is skewed to the downside from here.`,
  (f) => `RSI ${f.rsi} on the ${f.tf} — momentum this extended rarely holds without a pause.`,
  (f) => `The ${f.tf} chart is overbought at RSI ${f.rsi}. A rotation lower would relieve the pressure.`,
  (f) => `Heat check: ${f.tf} RSI ${f.rsi}. Overbought readings like this often mark short-term tops.`,
  (f) => `${f.tf} RSI at ${f.rsi} and rising. The move is mature, not early.`,
  (f) => `Overbought exhaustion showing on the ${f.tf}, RSI ${f.rsi}. Fading strength here.`,
  (f) => `RSI ${f.rsi} — the ${f.tf} is priced for perfection and vulnerable to a snap back.`,
  (f) => `Extended rally, ${f.tf} RSI ${f.rsi}. Taking the other side while momentum is stretched.`,
  (f) => `${f.exch} ${f.tf}: RSI ${f.rsi}. Overbought conditions favour sellers over the next legs.`,
  (f) => `Upside momentum is peaking — RSI ${f.rsi} on the ${f.tf}. Reversion trade setting up.`,
];

const RSI_LONG_DESCS = [
  (f) => `RSI dropped to ${f.rsi} on the ${f.tf} chart, deep in oversold territory where bounces tend to form.`,
  (f) => `Selling looks exhausted: ${f.tf} RSI at ${f.rsi}. Downside momentum is running out.`,
  (f) => `Oversold on the ${f.tf} with RSI ${f.rsi} — readings this low rarely persist for long.`,
  (f) => `${f.tf} RSI at ${f.rsi}. Price has been pushed too far down and mean reversion favours a bounce.`,
  (f) => `Stretched to the downside — RSI ${f.rsi} on the ${f.tf}. Watching for the recovery back toward balance.`,
  (f) => `${f.tf} RSI printed ${f.rsi}, deep in oversold. Capitulation often marks the turn.`,
  (f) => `Oversold signal on ${f.exch}: ${f.tf} RSI ${f.rsi}. Risk is skewed to the upside from here.`,
  (f) => `RSI ${f.rsi} on the ${f.tf} — sellers have done most of the damage already.`,
  (f) => `The ${f.tf} chart is oversold at RSI ${f.rsi}. A relief move would be the natural reaction.`,
  (f) => `Washout check: ${f.tf} RSI ${f.rsi}. Oversold readings like this often mark short-term bottoms.`,
  (f) => `${f.tf} RSI at ${f.rsi} and falling. The flush is late-stage, not early.`,
  (f) => `Oversold exhaustion showing on the ${f.tf}, RSI ${f.rsi}. Buying weakness here.`,
  (f) => `RSI ${f.rsi} — the ${f.tf} is priced for disaster and due a snap back.`,
  (f) => `Extended flush, ${f.tf} RSI ${f.rsi}. Taking the other side while momentum is stretched.`,
  (f) => `${f.exch} ${f.tf}: RSI ${f.rsi}. Oversold conditions favour buyers over the next legs.`,
  (f) => `Downside momentum is bottoming — RSI ${f.rsi} on the ${f.tf}. Reversion trade setting up.`,
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
  const rsiSource = s.signal.source === "cyclonersi";
  const pool = rsiSource
    ? (long ? RSI_LONG_DESCS : RSI_SHORT_DESCS)
    : (long ? LONG_DESCS : SHORT_DESCS);
  const desc = pick(pool, seed, 7)(facts(s));

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
//
// Binance blocks Cloudflare Workers' egress IPs: this Worker gets a plain nginx 403
// from /content/add while a GitHub Actions runner and a home connection both get 200.
// Workers cannot choose their egress IP, so the publish hop is delegated to a GitHub
// Action, which Cloudflare CAN reach. Everything else -- scheduling, parsing, the coin
// filter, rate limiting and state -- stays here.

const WORKFLOW_FILE = "publish-square.yml";

/**
 * Trigger the GitHub workflow that publishes to Binance Square.
 * Returns 204 with no body on success.
 */
export async function dispatchPublish(env, text, meta, image) {
  const repo = env.GITHUB_REPO || "abdoartistico/whale-signals";
  const token = env.GITHUB_TOKEN || "";
  if (!token) return { ok: false, error: "GITHUB_TOKEN is not set" };

  let res;
  try {
    res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "whale-signals-worker", // GitHub rejects requests without one
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ref: env.GITHUB_REF || "main",
        inputs: { text, meta: JSON.stringify(meta), image: image || "" },
      }),
    });
  } catch (err) {
    return { ok: false, error: `network: ${err}` };
  }

  if (res.status === 204) return { ok: true };
  const body = await res.text();
  return { ok: false, error: `github ${res.status}: ${body.slice(0, 200)}` };
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

  if (!env.GITHUB_TOKEN && !dryRun) return { error: "GITHUB_TOKEN is not set" };

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
    for (const [id, text, image] of fresh) {
      const sig = PARSERS[src.key](text, id);
      if (!sig) continue;
      if (CONFIG.usdtPairsOnly && !STABLE_QUOTES.has(sig.quote)) continue;
      if (CONFIG.excludeStablecoins && STABLE_BASES.has(sig.base)) continue;
      if (!CONFIG.allowShorts && sig.side === "sell") continue;
      eligible.push({ sig, image });
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
      const { sig, image } = eligible[eligible.length - 1]; // newest is the most tradable
      const s = buildSetup(sig, CONFIG);
      const text = render(s, sig.msgId);

      if (dryRun) {
        log.push(`[dry] ${sig.symbol} ${s.direction} (${eligible.length} eligible, posting newest)\nimage: ${image || "none"}\n${text}`);
      } else {
        const meta = {
          image: image || "",
          ticker: s.ticker,
          direction: s.direction,
          entry: `${s.entryLow} - ${s.entryHigh}`,
          sl: s.stop,
          tps: s.targets.join(" / "),
          used: state.quota.count + 1,
          cap: CONFIG.maxPostsPerDay,
        };
        const r = await dispatchPublish(env, text, meta, image);
        if (!r.ok) {
          log.push(`dispatch FAILED ${sig.symbol}: ${r.error}`);
        } else {
          // Dispatch accepted. The Action performs the Binance post and sends the
          // Telegram confirmation with the link. Counting here (rather than on the
          // Action's result) can only ever under-post, never breach the daily cap.
          log.push(`dispatched ${sig.symbol} ${s.direction}${image ? " +image" : " (no image)"} to GitHub for publishing`);
          state.quota.count += 1;
          state.quota.lastPostMs = nowMs;
          state.sentTotal = (state.sentTotal || 0) + 1;
          posted += 1;
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
    if (url.pathname === "/dry") return json(await runOnce(env, { dryRun: true }));
    if (url.pathname === "/run") {
      if (env.ADMIN_KEY && url.searchParams.get("key") !== env.ADMIN_KEY) return json({ error: "bad key" }, 403);
      return json(await runOnce(env, { force: url.searchParams.get("force") === "1" }));
    }
    return json({ endpoints: ["/health", "/state", "/dry", "/run?key=...&force=1"] });
  },
};
