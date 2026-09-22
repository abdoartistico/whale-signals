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
  entryZonePct: 0.5,
  // Stop loss and targets are measured from the MIDPOINT of the entry range.
  stopLossPct: 7.0,
  takeProfitPcts: [4.0, 8.0, 12.0],

  excludeStablecoins: true,
  allowShorts: true,
  usdtPairsOnly: true,

  // Binance Square limits are PER ACCOUNT: 100 posts/day, 400 uploads/day.
  maxPostsPerDay: 95,          // per account
  minMinutesBetweenPosts: 15,  // per account => at most 96/day, cap unreachable
  // Across accounts: no two posts may land within this many minutes of each other,
  // so the two profiles never publish at the same time.
  minMinutesBetweenAnyPosts: 6,
  // The same coin will not be republished by either account inside this window,
  // so the two feeds do not mirror each other. Relaxed if nothing else is available.
  symbolCooldownHours: 4,
  // Publishing goes through the GitHub Action (see publishing section for why).
  // Telegram receives a confirmation with the Binance post link from that Action.
};

// WhaleTracker and the pump channel are kept and still parsed by tests, but dormant.
const SOURCES = [{ key: "cyclonersi", channel: "CycloneRSI" }];

// Two Binance Square profiles drawing from the same channel. Their API keys live in
// GitHub secrets (the Worker never touches Binance directly), selected by this key.
const ACCOUNTS = [
  { key: "a", label: "A" },
  { key: "b", label: "B" },
];

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
 * Direction follows momentum continuation, not mean reversion:
 *   Overbought / Extreme Overbought / Bullish crossover -> LONG
 *   Oversold   / Extreme Oversold   / Bearish crossover -> SHORT
 * (The channel runs ~74% overbought, so expect a mostly-LONG feed.)
 */
const RE_CY_HEAD = /\$?([A-Z0-9]+)\/([A-Z]+)\s*\(([^)]+)\)\s*(Extreme\s+)?(Overbought|Oversold|Bullish|Bearish)\b/i;
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

  // Momentum continuation: strength begets strength, weakness begets weakness.
  const bullish = /Overbought|Bullish/i.test(head[5]);
  sig.side = bullish ? "buy" : "sell";
  sig.direction = bullish ? "LONG" : "SHORT";

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

  // Entry range straddles the alert price in the direction of the trade:
  //   LONG  -> price .. price * 1.005     SHORT -> price * 0.995 .. price
  const z = cfg.entryZonePct / 100;
  const lo = long ? p : p * (1 - z);
  const hi = long ? p * (1 + z) : p;
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
// Fixed layout:
//
//   $ASSET — LONG 🟢
//
//   <market description>
//
//   Entry: <min> – <max>
//   SL: <value>
//
//   TP1: <value>
//   TP2: <value>
//   TP3: <value>
//
//   <call to action with emoji>
//
//   $ASSET
//
// Two rotating slots -- the description and the CTA -- drawn independently by hash
// of the message id. Several descriptions interpolate the alert's own RSI and
// timeframe, so posts about different coins never read alike even on a repeat draw.

function facts(s) {
  const g = s.signal;
  return {
    rsi: g.rsi == null ? "" : g.rsi.toFixed(2),
    tf: g.timeframe || "",
    exch: g.exchange || "Binance",
  };
}

const LONG_DESCS = [
  (f) => `Momentum is expanding to the upside as buyers absorb every offer on the ${f.tf}.`,
  (f) => `Order-flow has tilted decisively to the bid, with buy-side pressure building through the ${f.tf}.`,
  (f) => `Liquidity above is thinning out while demand keeps stepping in — a classic continuation profile.`,
  (f) => `Buyer pressure is dominating the tape, and ${f.tf} RSI at ${f.rsi} confirms momentum is live.`,
  (f) => `Upside expansion in progress: resting supply is being cleared faster than it can be replaced.`,
  (f) => `The bid is stacking aggressively and each pullback is getting bought before it develops.`,
  (f) => `Strength is broadening out on the ${f.tf}, with order-flow favouring continuation over reversal.`,
  (f) => `Momentum velocity is accelerating as liquidity shifts toward the buy side.`,
  (f) => `Demand has taken control of this range and sellers are struggling to defend it.`,
  (f) => `${f.tf} RSI printed ${f.rsi} — momentum is confirmed rather than exhausted at this stage.`,
  (f) => `Buyers are lifting offers into thinning resistance, which tends to accelerate the move.`,
  (f) => `Order book imbalance is firmly bullish, with depth drying up above current price.`,
  (f) => `Trend expansion underway on ${f.exch}, supported by persistent buy-side flow.`,
  (f) => `Every dip is being absorbed quickly — a sign of real demand rather than a short squeeze.`,
  (f) => `Momentum has broken out of its recent compression and buyers are pressing the advantage.`,
  (f) => `Liquidity is rotating into this pair, lifting price through prior supply with ease.`,
  (f) => `Buy pressure is sustained rather than spiky, which favours follow-through on the ${f.tf}.`,
  (f) => `Sellers have stepped back and the path of least resistance now points higher.`,
  (f) => `Aggressive bidding is clearing the book, with ${f.tf} momentum firmly on the buy side.`,
  (f) => `Upside velocity is building as participation increases and supply thins.`,
  (f) => `Directional conviction is showing in the flow, with buyers controlling every retest.`,
  (f) => `The ${f.tf} structure has shifted bullish and momentum is carrying price forward.`,
  (f) => `Order-flow expansion favours longs while demand keeps outpacing available supply.`,
  (f) => `Strong bid absorption at ${f.rsi} RSI on the ${f.tf} — momentum is intact, not fading.`,
];

const SHORT_DESCS = [
  (f) => `Breakdown velocity is picking up as sellers hit every bid on the ${f.tf}.`,
  (f) => `Order-flow has rolled over to the offer, with sell-side pressure compounding.`,
  (f) => `Liquidity below is thin and supply keeps stepping in — continuation lower is favoured.`,
  (f) => `Seller pressure is dominating the tape, and ${f.tf} RSI at ${f.rsi} confirms weakness is live.`,
  (f) => `Downside expansion in progress: resting bids are being cleared faster than they refill.`,
  (f) => `The offer is stacking aggressively and every bounce is being sold into.`,
  (f) => `Weakness is broadening out on the ${f.tf}, with order-flow favouring continuation lower.`,
  (f) => `Breakdown velocity is accelerating as liquidity shifts toward the sell side.`,
  (f) => `Supply has taken control of this range and buyers are failing to defend it.`,
  (f) => `${f.tf} RSI printed ${f.rsi} — weakness is confirmed rather than washed out at this stage.`,
  (f) => `Sellers are hitting bids into thinning support, which tends to accelerate the decline.`,
  (f) => `Order book imbalance is firmly bearish, with depth drying up beneath current price.`,
  (f) => `Trend breakdown underway on ${f.exch}, supported by persistent sell-side flow.`,
  (f) => `Every bounce is being distributed into — a sign of real supply rather than a flush.`,
  (f) => `Momentum has broken down out of compression and sellers are pressing the advantage.`,
  (f) => `Liquidity is rotating out of this pair, dragging price through prior support.`,
  (f) => `Sell pressure is sustained rather than spiky, which favours follow-through on the ${f.tf}.`,
  (f) => `Buyers have stepped back and the path of least resistance now points lower.`,
  (f) => `Aggressive offering is clearing the book, with ${f.tf} momentum firmly on the sell side.`,
  (f) => `Downside velocity is building as participation increases and bids thin out.`,
  (f) => `Directional conviction is showing in the flow, with sellers controlling every retest.`,
  (f) => `The ${f.tf} structure has shifted bearish and momentum is carrying price down.`,
  (f) => `Order-flow contraction favours shorts while supply keeps outpacing available demand.`,
  (f) => `Heavy offer absorption at ${f.rsi} RSI on the ${f.tf} — weakness is intact, not fading.`,
];

const CTAS = [
  "Position early and manage your risk 🚀",
  "Set your orders and let the move work 📈",
  "Watch the entry zone and act decisively ⚡",
  "Scale in carefully and respect the stop 🎯",
  "Get positioned before the expansion 🔥",
  "Plan the trade, then trade the plan 💡",
  "Size it properly and stay disciplined 🛡️",
  "Track the levels and stay patient ⏱️",
  "Follow the flow and protect your downside 💎",
  "Enter on your terms, not the market's 🧠",
  "Keep the stop tight and let winners run 🏁",
  "Take the setup and manage it actively 📊",
  "Stay sharp — the levels do the work ✅",
  "Trade it clean and bank the targets 💰",
  "Execute with a plan, not emotion 🧭",
  "Mark the levels and wait for your fill 📌",
  "Respect the invalidation and stay nimble 🔑",
  "Let the setup come to you 🕐",
  "Manage risk first, profits follow 📗",
  "Stay selective and let this one develop 🌊",
];

/**
 * Integer hash so each rotating slot is drawn independently.
 * A linear stride (seed * salt) makes the slots move in lockstep, which collapses the
 * variety to the pool length; hashing keeps description and CTA uncorrelated.
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
  const desc = pick(long ? LONG_DESCS : SHORT_DESCS, seed, 7)(facts(s));
  const cta = pick(CTAS, seed, 13);

  return `${s.ticker} — ${s.direction} ${long ? "🟢" : "🔴"}

${desc}

Entry: ${s.entryLow} – ${s.entryHigh}
SL: ${s.stop}

TP1: ${s.targets[0]}
TP2: ${s.targets[1]}
TP3: ${s.targets[2]}

${cta}

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
export async function dispatchPublish(env, text, meta, image, account) {
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
        inputs: { text, meta: JSON.stringify(meta), image: image || "", account: account || "a" },
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

/** Per-account daily counter; Binance quotas reset at 00:00 UTC. */
function accountState(state, acct, nowMs) {
  const today = utcDay(nowMs);
  if (!state.accounts) state.accounts = {};
  let a = state.accounts[acct];
  if (!a || a.date !== today) {
    a = { date: today, count: 0, lastPostMs: a?.lastPostMs || 0 };
    state.accounts[acct] = a;
  }
  return a;
}

/** Drop history older than the symbol cooldown so the list cannot grow forever. */
function prunePosted(state, nowMs) {
  const cutoff = nowMs - CONFIG.symbolCooldownHours * 3600 * 1000;
  state.posted = (state.posted || []).filter((e) => e.ms >= cutoff).slice(-400);
  return state.posted;
}

/**
 * Choose what an account should publish.
 * Never repeats a message either account already posted; prefers a coin neither has
 * posted recently, but falls back to a repeated symbol rather than posting nothing.
 */
export function chooseFor(eligible, posted) {
  const usedIds = new Set(posted.map((e) => e.id));
  const recentSymbols = new Set(posted.map((e) => e.symbol));
  const unused = eligible.filter((e) => !usedIds.has(e.sig.msgId));
  if (!unused.length) return null;
  for (let i = unused.length - 1; i >= 0; i--) {
    if (!recentSymbols.has(unused[i].sig.symbol)) return unused[i];
  }
  return unused[unused.length - 1]; // every symbol seen recently: take the newest anyway
}

async function runOnce(env, { dryRun = false, force = false } = {}) {
  if (!env.GITHUB_TOKEN && !dryRun) return { error: "GITHUB_TOKEN is not set" };

  const nowMs = Date.now();
  const stored = await env.STATE.get("state", { type: "json" });
  const state = stored || { sentTotal: 0, channels: {} };
  if (!state.channels) state.channels = {};
  const posted = prunePosted(state, nowMs);

  const log = [];
  const perSource = {};
  let dispatched = 0;
  let changed = false;

  // --- collect eligible signals from the source ---
  let eligible = [];
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

    for (const [id, text, image] of fresh) {
      const sig = PARSERS[src.key](text, id);
      if (!sig) continue;
      if (CONFIG.usdtPairsOnly && !STABLE_QUOTES.has(sig.quote)) continue;
      if (CONFIG.excludeStablecoins && STABLE_BASES.has(sig.base)) continue;
      if (!CONFIG.allowShorts && sig.side === "sell") continue;
      eligible.push({ sig, image });
    }

    perSource[src.key] = { fetched: posts.length, fresh: fresh.length, eligible: eligible.length, lastId: highest };
    if (highest !== since) {
      // Advance past everything seen. Alerts the rate limit skipped are stale by the
      // next window and must not queue up behind it.
      state.channels[src.key] = highest;
      changed = true;
    }
  }

  // --- hand one signal to each account that is due ---
  if (!eligible.length) log.push("no new eligible signals this tick");
  const accounts = {};
  for (const acct of ACCOUNTS) {
    const a = accountState(state, acct.key, nowMs);
    accounts[acct.key] = { used: a.count, cap: CONFIG.maxPostsPerDay };

    const sinceOwn = (nowMs - (a.lastPostMs || 0)) / 60000;
    const sinceAny = (nowMs - (state.lastAnyPostMs || 0)) / 60000;

    if (!eligible.length) continue;
    if (a.count >= CONFIG.maxPostsPerDay && !force) {
      log.push(`${acct.label}: daily cap ${a.count}/${CONFIG.maxPostsPerDay}, waiting for UTC reset`);
      continue;
    }
    if (sinceOwn < CONFIG.minMinutesBetweenPosts && !force) {
      log.push(`${acct.label}: own pacing, ${(CONFIG.minMinutesBetweenPosts - sinceOwn).toFixed(1)} min to go`);
      continue;
    }
    if (sinceAny < CONFIG.minMinutesBetweenAnyPosts && !force) {
      // keeps the two profiles from posting at the same moment
      log.push(`${acct.label}: spacing from the other account, ${(CONFIG.minMinutesBetweenAnyPosts - sinceAny).toFixed(1)} min to go`);
      continue;
    }

    const chosen = chooseFor(eligible, posted);
    if (!chosen) {
      log.push(`${acct.label}: nothing new to post (all candidates already used)`);
      continue;
    }
    const { sig, image } = chosen;
    const s = buildSetup(sig, CONFIG);
    // salt the seed per account so wording diverges even for a similar setup
    const text = render(s, sig.msgId + (acct.key === "b" ? 977 : 0));

    if (dryRun) {
      log.push(`[dry ${acct.label}] ${sig.symbol} ${s.direction}\nimage: ${image || "none"}\n${text}`);
      posted.push({ id: sig.msgId, symbol: sig.symbol, ms: nowMs, account: acct.key });
      continue;
    }

    const meta = {
      account: acct.label,
      image: image || "",
      ticker: s.ticker,
      direction: s.direction,
      entry: `${s.entryLow} - ${s.entryHigh}`,
      sl: s.stop,
      tps: s.targets.join(" / "),
      used: a.count + 1,
      cap: CONFIG.maxPostsPerDay,
    };
    const r = await dispatchPublish(env, text, meta, image, acct.key);
    if (!r.ok) {
      log.push(`${acct.label}: dispatch FAILED ${sig.symbol}: ${r.error}`);
      continue;
    }
    log.push(`${acct.label}: dispatched ${sig.symbol} ${s.direction}${image ? " +image" : " (no image)"}`);
    a.count += 1;
    a.lastPostMs = nowMs;
    state.lastAnyPostMs = nowMs;
    state.sentTotal = (state.sentTotal || 0) + 1;
    posted.push({ id: sig.msgId, symbol: sig.symbol, ms: nowMs, account: acct.key });
    accounts[acct.key].used = a.count;
    dispatched += 1;
    changed = true;
  }

  if (changed && !dryRun) {
    delete state.lastId;
    delete state.quota;
    state.posted = posted;
    await env.STATE.put("state", JSON.stringify(state));
  }

  return { sources: perSource, dispatched, accounts, recentlyPosted: posted.length, log };
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
      return json({ ok: true, sources: SOURCES.map((s) => s.channel), accounts: ACCOUNTS.map((a) => a.label) });
    if (url.pathname === "/state") return json((await env.STATE.get("state", { type: "json" })) || { channels: {} });
    if (url.pathname === "/dry") return json(await runOnce(env, { dryRun: true }));
    if (url.pathname === "/run") {
      if (env.ADMIN_KEY && url.searchParams.get("key") !== env.ADMIN_KEY) return json({ error: "bad key" }, 403);
      return json(await runOnce(env, { force: url.searchParams.get("force") === "1" }));
    }
    return json({ endpoints: ["/health", "/state", "/dry", "/run?key=...&force=1"] });
  },
};
