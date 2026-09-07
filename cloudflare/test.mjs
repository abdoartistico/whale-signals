/** Offline checks. Run: node test.mjs */

import { parseMessage, parsePumpDetector, buildSetup, render, extractPosts } from "./src/worker.js";

const CFG = { entryZonePct: 0.4, stopLossPct: 7.0, takeProfitPcts: [4.0, 8.0, 12.0] };
const fails = [];
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) fails.push(`${label}: got ${g}, want ${w}`);
};

const wt = (sym, buying, price) => `┌ #${sym} ${buying ? "✳️ Buying" : "🔴 Selling"} Volume
├ 203.96K ₮ volume in 1m
┊├ Buy [${buying ? 81 : 19}%]: 166.51K ₮
┊└ Sell [-${buying ? 19 : 81}%]: -37.45K ₮
├Price: ${price}→${price} (0.3%)
├Change: 24h[5.327%] 4h[0.98%]
┊└ 15m[0.33%] 1h[0.56%]
├24h Volume: 13.910M ₮
┊├ Buy [50%]: 7.019M ₮
┊└ Sell [-50%]: -6.891M ₮
├Net Vol: 15m[15%] 1h[14%] 4h[6%]
└Alerts: 24h[3] 4h[2]`;

const AAVE = wt("AAVEUSDT", true, "96.63");

// --- parsing still intact ---
const a = parseMessage(AAVE, 1);
eq("base", a.base, "AAVE");
eq("quote", a.quote, "USDT");
eq("side", a.side, "buy");
eq("price", a.price, 96.63);
eq("dominance", a.dominance, 81);
eq("vol24h", a.vol24h, 13910000);
eq("non-signal -> null", parseMessage("hello world", 2), null);
eq("chinese ticker -> null", parseMessage("┌ #币安人生USDT ✳️ Buying Volume\n├Price: 1→1 (0.0%)", 3), null);

// --- levels: entry ends AT the alert price, SL/TP measured from the midpoint ---
const s = buildSetup(a, CFG);
const p = 96.63, lo = p * (1 - 0.004), mid = (lo + p) / 2;
eq("entry high is the alert price", s.entryHigh, p.toFixed(2));
eq("entry low is below it", s.entryLow, lo.toFixed(2));
eq("SL is 7% below the entry midpoint", s.stop, (mid * 0.93).toFixed(2));
eq("TP1 is +4% from midpoint", s.targets[0], (mid * 1.04).toFixed(2));
eq("TP2 is +8% from midpoint", s.targets[1], (mid * 1.08).toFixed(2));
eq("TP3 is +12% from midpoint", s.targets[2], (mid * 1.12).toFixed(2));

const sh = buildSetup(parseMessage(wt("ETHUSDT", false, "1910.4"), 4), CFG);
eq("short direction", sh.direction, "SHORT");
eq("short stop is ABOVE price", Number(sh.stop.replace(/,/g, "")) > 1910.4, true);
eq("short targets descend", sh.targets.map((t) => Number(t.replace(/,/g, ""))).every((v, i, arr) => i === 0 || v < arr[i - 1]), true);
eq("thousands separator", sh.entryHigh, "1,910.4");
eq("no comma on small prices", s.entryLow.includes(","), false);

// --- the required post structure, literally ---
const out = render(s, 1);
const lines = out.split("\n");
eq("line 0 is $TICKER — header", /^\$AAVE — .+/.test(lines[0]), true);
eq("line 1 blank", lines[1], "");
eq("Entry line", /^Entry: [\d.,]+ - [\d.,]+$/.test(lines[2]), true);
eq("SL line", /^SL: [\d.,]+$/.test(lines[3]), true);
eq("line 4 blank", lines[4], "");
eq("TP1 line", /^TP1: [\d.,]+$/.test(lines[5]), true);
eq("TP2 line", /^TP2: [\d.,]+$/.test(lines[6]), true);
eq("TP3 line", /^TP3: [\d.,]+$/.test(lines[7]), true);
eq("line 8 blank", lines[8], "");
eq("description present", lines[9].length > 20, true);
eq("line 10 blank", lines[10], "");
eq("CTA line", lines[11], "Trade here 👇");
eq("last line is ticker", lines[12], "$AAVE");
eq("exactly 13 lines", lines.length, 13);
eq("no markdown", /[*_]/.test(out), false);
eq("LONG header says LONG", /LONG setup/.test(out), true);
eq("SHORT header says SHORT", /SHORT setup/.test(render(sh, 2)), true);
eq("SHORT never says LONG", /LONG/.test(render(sh, 2)), false);

// --- rotation ---
const msgs = new Set(), heads = new Set(), descs = new Set();
for (let seed = 0; seed < 200; seed++) {
  const m = render(s, seed);
  msgs.add(m);
  heads.add(m.split("\n")[0]);
  descs.add(m.split("\n")[9]);
}
eq("headers rotate", heads.size >= 20, true);
eq("descriptions rotate", descs.size >= 15, true);
eq("200 signals stay varied", msgs.size >= 150, true);
// header and description must not advance in lockstep
eq("slots decorrelated", msgs.size > Math.max(heads.size, descs.size), true);

// --- Binance Square post length is well within any sane cap ---
eq("post is short", out.length < 600, true);

// --- the excluded coin list ---
const EXCLUDED = ["USDT", "USDC", "FDUSD", "TUSD", "USDP", "USDD", "DAI", "EURI", "EURT",
  "AEUR", "PYUSD", "GUSD", "FRAX", "LUSD", "SUSD", "MUSD", "USDX", "CEUR", "XSGD", "TRYB", "BRLZ"];
import { readFileSync } from "fs";
const src = readFileSync("./src/worker.js", "utf8");
const setBlock = src.slice(src.indexOf("const STABLE_BASES"), src.indexOf("const QUOTES"));
for (const c of EXCLUDED) {
  if (!new RegExp(`"${c}"`).test(setBlock)) fails.push(`excluded coin ${c} missing from STABLE_BASES`);
}
eq("stablecoin exclusion is enabled", /excludeStablecoins:\s*true/.test(src), true);
eq("daily cap under Binance's 100", Number(src.match(/maxPostsPerDay:\s*(\d+)/)[1]) < 100, true);
const gap = Number(src.match(/minMinutesBetweenPosts:\s*(\d+)/)[1]);
eq("pacing cannot exceed the daily cap", Math.floor((24 * 60) / gap) <= 100, true);

// --- pump parser kept working though dormant ---
const pump = parsePumpDetector(`🚀 Pump - REZ/USDT [Binance]
💰Price: $0.00262 ➜ $0.00296 (+13.11%)
📊Volume: $1.85M (+137.42%)
Volume increased by $1.07M ⬆`, 100);
eq("pump parser intact", pump && pump.price, 0.00296);
eq("numeric entity decoded", extractPosts('<div data-post="c/1"><div class="js-message_text">&#036;5</div></div>')[0][1], "$5");

if (fails.length) {
  console.log("FAILED:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
const fails2 = [];
console.log(`all checks passed — post structure verified line by line, ${heads.size} headers x ${descs.size} descriptions`);
console.log("\nsample:\n" + out);

// --- Telegram confirmation carries the Binance link ---
import { confirmationText } from "./src/worker.js";
const conf = confirmationText(s, { ok: true, link: "https://www.binance.com/square/post/12345" }, { used: 12, cap: 95 });
if (!conf.includes("https://www.binance.com/square/post/12345")) fails2.push("confirmation is missing the post link");
if (!conf.includes("$AAVE")) fails2.push("confirmation is missing the ticker");
if (!conf.includes("12/95")) fails2.push("confirmation is missing the quota");
// the 504 case must say so rather than showing a broken/absent link
const conf504 = confirmationText(s, { ok: true, link: null, note: "success_without_post_id" }, { used: 1, cap: 95 });
if (!/no link/i.test(conf504)) fails2.push("504 case does not explain the missing link");
if (fails2.length) { console.log("CONFIRMATION FAILED:"); fails2.forEach(f=>console.log("  -",f)); process.exit(1); }
console.log("\nconfirmation message:\n" + conf);
