/** Verify the Worker port matches the Python bot. Run: node cloudflare/test.mjs */

import { parseMessage, parsePumpDetector, buildSetup, render, TEMPLATE_NAMES, extractPosts } from "./src/worker.js";

const AAVE = `┌ #AAVEUSDT ✳️ Buying Volume
├ 203.96K ₮ volume in 1m
┊├ Buy [81%]: 166.51K ₮
┊└ Sell [-19%]: -37.45K ₮
├Price: 96.38→96.63 (0.3%)
├Change: 24h[5.327%] 4h[0.98%]
┊└ 15m[0.33%] 1h[0.56%]
├24h Volume: 13.910M ₮
┊├ Buy [50%]: 7.019M ₮
┊└ Sell [-50%]: -6.891M ₮
├Net Vol: 15m[15%] 1h[14%] 4h[6%]
└Alerts: 24h[3] 4h[2]`;

const ETHBTC = `┌ #ETHBTC 🔴 Selling Volume
├ 1.0013 Ƀ volume in 1m
┊├ Buy [0%]: 0.0000 Ƀ
┊└ Sell [-100%]: -1.0013 Ƀ
├Price: 0.02932→0.02932 (0.0%)
├Change: 24h[0.791%] 4h[0.31%]
┊└ 15m[0.03%] 1h[0.27%]
├24h Volume: 63.6799 Ƀ
┊├ Buy [48%]: 30.8209 Ƀ
┊└ Sell [-52%]: -32.8589 Ƀ
├Net Vol: 15m[-16%] 1h[14%] 4h[8%]
└Alerts: 24h[8] 4h[2]`;

const CFG = { entryZonePct: 0.4, stopLossPct: 5.0, takeProfitPcts: [4.0, 8.0, 12.0] };
const fails = [];
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) fails.push(`${label}: got ${g}, want ${w}`);
};

// --- parsing: must match the Python assertions exactly ---
const a = parseMessage(AAVE, 1);
eq("symbol", a.symbol, "AAVEUSDT");
eq("base", a.base, "AAVE");
eq("quote", a.quote, "USDT");
eq("side", a.side, "buy");
eq("alertVolume", a.alertVolume, 203960);
eq("window", a.window, "1m");
eq("buyPct", a.buyPct, 81);
eq("sellPct", a.sellPct, -19);
eq("price", a.price, 96.63);
eq("change24h", a.change["24h"], 5.327);
eq("change15m", a.change["15m"], 0.33);
eq("vol24h", a.vol24h, 13910000);
eq("netVol", a.netVol, { "15m": 15, "1h": 14, "4h": 6 });
eq("alerts", [a.alerts24h, a.alerts4h], [3, 2]);
eq("dominance", a.dominance, 81);

const e = parseMessage(ETHBTC, 2);
eq("ethbtc base", e.base, "ETH");
eq("ethbtc quote", e.quote, "BTC");
eq("ethbtc dominance", e.dominance, 100);

eq("non-signal -> null", parseMessage("hello world", 3), null);
eq("chinese ticker -> null (skipped by design)", parseMessage("┌ #币安人生USDT ✳️ Buying Volume\n├Price: 1→1 (0.0%)", 4), null);

// --- levels: identical to the Python test expectations ---
const s = buildSetup(a, CFG);
eq("direction", s.direction, "LONG");
eq("ticker", s.ticker, "$AAVE");
eq("entry", [s.entryLow, s.entryHigh], ["96.44", "96.82"]);
eq("stop", s.stop, "91.80");
eq("targets", s.targets, ["100.50", "104.36", "108.23"]);
eq("rr", s.rr, "1.6");

const ss = buildSetup(e, CFG);
eq("short ticker keeps quote", ss.ticker, "$ETH/BTC");
eq("short stop above price", Number(ss.stop) > e.price, true);
eq("small price precision", ss.stop, "0.03079");

const decs = new Set([s.entryLow, s.entryHigh, s.stop, ...s.targets].map((x) => x.split(".")[1].length));
eq("uniform precision", decs.size, 1);

// --- rendering ---
eq("template count", TEMPLATE_NAMES.length, 7);
for (let i = 0; i < TEMPLATE_NAMES.length; i++) {
  const out = render(s, i, i);
  if (!out.trim() || out.includes("undefined") || out.includes("NaN")) fails.push(`template ${TEMPLATE_NAMES[i]} bad:\n${out}`);
  if ((out.match(/\*/g) || []).length % 2) fails.push(`template ${TEMPLATE_NAMES[i]} unbalanced bold`);
}
eq("rotation wraps", render(s, 0, 1), render(s, 7, 1));
eq("neighbours differ", render(s, 0, 1) === render(s, 1, 2), false);

// --- second source: cointrendz_pumpdetector ---
const PUMP = `🚀 Pump - REZ/USDT [Binance]
Pump Activity on REZ/USDT 🟢🟢
💰Price: $0.00262 ➜ $0.00296 (+13.11%)
📊Volume: $1.85M (+137.42%)
Volume increased by $1.07M ⬆`;

const p = parsePumpDetector(PUMP, 100);
eq("pump base", p.base, "REZ");
eq("pump quote", p.quote, "USDT");
eq("pump symbol", p.symbol, "REZUSDT");
eq("pump exchange", p.exchange, "Binance");
eq("pump side", p.side, "buy");
eq("pump direction", p.direction, "LONG");
eq("pump priceFrom", p.priceFrom, 0.00262);
eq("pump price", p.price, 0.00296);
eq("pump move", p.priceMovePct, 13.11);
eq("pump vol24h", p.vol24h, 1850000);
eq("pump volChangePct", p.volChangePct, 137.42);
eq("pump volIncrease", p.volIncrease, 1070000);
eq("pump source tag", p.source, "pumpdetector");

// promotional posts and off-format messages must fall out, not throw
eq("promo post -> null", parsePumpDetector("✨Bot Command Showcase✨\n\nFeatured command: /fed 🔥", 101), null);
eq("wt message not parsed as pump", parsePumpDetector(AAVE, 102), null);
eq("pump message not parsed as wt", parseMessage(PUMP, 103), null);

const ps = buildSetup(p, CFG);
eq("pump ticker", ps.ticker, "$REZ");
eq("pump direction kept", ps.direction, "LONG");
eq("pump stop below price", Number(ps.stop) < p.price, true);
eq("pump targets ascend", ps.targets.map(Number).every((v, i, a) => i === 0 || v > a[i - 1]), true);
// tiny price must keep meaningful precision, not collapse to 0.00
eq("pump precision", ps.targets[0], "0.003078");

// every template must render this source without leaking undefined/NaN
for (let i = 0; i < TEMPLATE_NAMES.length; i++) {
  const out = render(ps, i, i);
  if (out.includes("undefined") || out.includes("NaN") || out.includes("n/a"))
    fails.push(`pump template ${TEMPLATE_NAMES[i]} leaked a missing field:\n${out}`);
  if ((out.match(/\*/g) || []).length % 2) fails.push(`pump template ${TEMPLATE_NAMES[i]} unbalanced bold`);
  // must not claim order-flow stats this source never publishes
  if (/dominance|Net volume/i.test(out))
    fails.push(`pump template ${TEMPLATE_NAMES[i]} claims order-flow data that does not exist:\n${out}`);
}

// --- regression: the pump channel emits "$" as the numeric entity &#036;.
// Decoding only named entities silently broke every price regex on that source.
const ENTITY_HTML =
  '<div data-post="c/9"><div class="tgme_widget_message_text js-message_text" dir="auto">' +
  "<b>🚀 Pump</b> - REZ/USDT [Binance]<br/>💰Price: &#036;0.00262 ➜ &#036;0.00296 (+13.11%)<br/>" +
  "📊Volume: &#036;1.85M (+137.42%)<br/>Volume increased by &#036;1.07M ⬆</div></div>";
const [[eid, etext]] = extractPosts(ENTITY_HTML);
eq("numeric entity decoded to $", etext.includes("$0.00262"), true);
eq("no raw entity left behind", etext.includes("&#036;"), false);
const ep = parsePumpDetector(etext, eid);
eq("entity-encoded message still parses", ep && ep.price, 0.00296);
eq("entity-encoded volume still parses", ep && ep.vol24h, 1850000);

// hex entities too
eq("hex entity decoded", extractPosts('<div data-post="c/1"><div class="js-message_text">&#x24;5</div></div>')[0][1], "$5");

if (fails.length) {
  console.log("FAILED:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
console.log(`worker port OK — ${TEMPLATE_NAMES.length} templates, levels match the Python bot exactly`);
console.log("\nsample output:\n" + render(s, 0, 0));
