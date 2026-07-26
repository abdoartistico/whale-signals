/** Verify the Worker port matches the Python bot. Run: node cloudflare/test.mjs */

import { parseMessage, buildSetup, render, TEMPLATE_NAMES } from "./src/worker.js";

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

if (fails.length) {
  console.log("FAILED:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
console.log(`worker port OK — ${TEMPLATE_NAMES.length} templates, levels match the Python bot exactly`);
console.log("\nsample output:\n" + render(s, 0, 0));
