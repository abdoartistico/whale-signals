/** Offline checks. Run: node test.mjs */

import { parseMessage, parsePumpDetector, parseCycloneRSI, buildSetup, render, extractPosts, chooseFor } from "./src/worker.js";

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
const EXCLUDED = [
  "USDT", "USDC", "BFUSD", "XUSD", "U", "FDUSD", "TUSD", "DAI", "USDP", "PYUSD", "USDD",
  "USDE", "GUSD", "FRAX", "LUSD", "SUSD", "ALUSD", "USDTB", "EURT", "EURS", "BRL", "BRLZ",
  "BUSD", "CADC", "NZDS", "TRYB", "GYEN", "JPYC", "XSGD", "EURL", "EURCV", "VEUR", "CNHT",
  "MIM", "CRVUSD", "DOLA", "HUSD", "OUSD", "USDX", "USN", "VAI", "STBL", "CUSD", "DJED",
  "AGEUR", "EEUR", "CEUR", "SEURO", "PAR", "MUSD", "EUSD", "TOR", "FEI", "USDV", "BOLD",
  "GRAI", "PRISMA", "USH", "YUSD", "ZUSD", "USDS", "USD0", "HYUSD", "MIMA", "BRLA", "ARS",
  "TRYG", "ZARV", "NGNV", "MXNT", "UAHC", "CNH", "IDRT", "PAXG", "XAUT", "PEPE"
];
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

// --- the publish hop is delegated, not done in the Worker ---
const wsrc = readFileSync("./src/worker.js", "utf8");
// The Worker must never hold a binance.com URL: its IP is blocked, so any direct
// call would 403. Comments may mention the endpoint; code may not contain the host.
eq("worker has no binance.com request URL", /["\x60]https:\/\/www\.binance\.com/.test(wsrc), false);
eq("worker dispatches to GitHub instead", /actions\/workflows\/\$\{WORKFLOW_FILE\}\/dispatches/.test(wsrc), true);
eq("dispatch sends a User-Agent (GitHub rejects requests without one)", /"User-Agent": "whale-signals-worker"/.test(wsrc), true);
eq("204 is treated as success", /res\.status === 204/.test(wsrc), true);

// --- CycloneRSI: the active source ---
const CY_OB = "$KERNEL/USDT (30m) Overbought level reached\nPrice: 0.0508 | RSI: 70.85 | Binance | TV";
const CY_OS = "$DOGE/USDT (4h) Extreme Oversold level reached\nPrice: 0.1234 | RSI: 18.40 | Binance | TV";

const ob = parseCycloneRSI(CY_OB, 500);
eq("cyclone base", ob.base, "KERNEL");
eq("cyclone quote", ob.quote, "USDT");
eq("cyclone timeframe", ob.timeframe, "30m");
eq("cyclone price", ob.price, 0.0508);
eq("cyclone rsi", ob.rsi, 70.85);
eq("cyclone exchange", ob.exchange, "Binance");
eq("cyclone source tag", ob.source, "cyclonersi");
// RSI mean reversion: overbought fades, oversold bounces
eq("overbought -> SHORT", ob.direction, "SHORT");
eq("overbought side", ob.side, "sell");

const os_ = parseCycloneRSI(CY_OS, 501);
eq("oversold -> LONG", os_.direction, "LONG");
eq("extreme flag", os_.extreme, true);
eq("extreme condition text", os_.condition, "Extreme Oversold");
eq("cyclone rsi low", os_.rsi, 18.4);

eq("non-cyclone text -> null", parseCycloneRSI("hello world", 502), null);
eq("whaletracker msg not parsed as cyclone", parseCycloneRSI(AAVE, 503), null);

// levels still behave for a SHORT
const cs = buildSetup(ob, CFG);
eq("cyclone ticker", cs.ticker, "$KERNEL");
eq("short stop above price", Number(cs.stop) > ob.price, true);

// descriptions must use RSI, never invented order-flow figures
const cyOut = render(cs, 500);
eq("uses the RSI reading", cyOut.includes("70.85"), true);
eq("no invented volume", /\$0\b|\$NaN|dominance/.test(cyOut), false);
const cyDescs = new Set();
for (let seed = 0; seed < 80; seed++) cyDescs.add(render(cs, seed).split("\n")[9]);
eq("RSI descriptions rotate", cyDescs.size >= 10, true);

// --- image extraction pairs the photo with its own message ---
const HTML = `<div data-post="CycloneRSI/1"><a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn5.telesco.pe/file/AAA')"></a>` +
  `<div class="tgme_widget_message_text js-message_text">$KERNEL/USDT (30m) Overbought level reached<br/>Price: 0.0508 | RSI: 70.85 | Binance | TV</div></div>` +
  `<div data-post="CycloneRSI/2"><a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn5.telesco.pe/file/BBB')"></a>` +
  `<div class="tgme_widget_message_text js-message_text">$DOGE/USDT (4h) Oversold level reached<br/>Price: 0.1234 | RSI: 25.00 | Binance | TV</div></div>`;
const ex = extractPosts(HTML);
eq("two posts extracted", ex.length, 2);
eq("post 1 image", ex[0][2], "https://cdn5.telesco.pe/file/AAA");
eq("post 2 image", ex[1][2], "https://cdn5.telesco.pe/file/BBB");
eq("post 1 text parses", parseCycloneRSI(ex[0][1], ex[0][0]).base, "KERNEL");
eq("post 2 text parses", parseCycloneRSI(ex[1][1], ex[1][0]).base, "DOGE");
// an avatar background-image must not be mistaken for the chart
const NOPIC = `<div data-post="c/3"><i class="tgme_widget_message_user_photo" style="background-image:url('https://cdn.telesco.pe/avatar')"></i>` +
  `<div class="tgme_widget_message_text js-message_text">no photo here</div></div>`;
eq("avatar is not treated as a chart", extractPosts(NOPIC)[0][2], null);

// --- the image must reach the publisher ---
eq("dispatch sends the image input", /inputs: \{ text, meta: JSON\.stringify\(meta\), image/.test(wsrc), true);

// --- two accounts: never the same post, never the same moment ---
const mk = (id, symbol) => ({ sig: { msgId: id, symbol }, image: null });
const pool = [mk(1, "AAAUSDT"), mk(2, "BBBUSDT"), mk(3, "CCCUSDT"), mk(4, "DDDUSDT")];

// nothing posted yet -> newest
eq("picks the newest when nothing is posted", chooseFor(pool, []).sig.msgId, 4);

// account A took msg 4; B must not repeat it
const afterA = [{ id: 4, symbol: "DDDUSDT", ms: Date.now(), account: "a" }];
const bPick = chooseFor(pool, afterA);
eq("second account never repeats the same message", bPick.sig.msgId === 4, false);
eq("second account also avoids the same symbol", bPick.sig.symbol === "DDDUSDT", false);
eq("second account takes the next newest unused", bPick.sig.msgId, 3);

// every id used -> nothing to post rather than a duplicate
const allUsed = pool.map((e) => ({ id: e.sig.msgId, symbol: e.sig.symbol, ms: Date.now(), account: "a" }));
eq("no duplicate when everything is used", chooseFor(pool, allUsed), null);

// same symbol recently posted under a different message id -> still allowed as fallback,
// so a busy symbol cannot starve the feed
const dupSymbols = [mk(10, "AAAUSDT"), mk(11, "AAAUSDT")];
const fb = chooseFor(dupSymbols, [{ id: 10, symbol: "AAAUSDT", ms: Date.now(), account: "a" }]);
eq("falls back to a repeated symbol rather than posting nothing", fb.sig.msgId, 11);

// config invariants that keep the two profiles apart and inside Binance's limits
eq("per-account cap is under Binance's 100", Number(src.match(/maxPostsPerDay:\s*(\d+)/)[1]) < 100, true);
const anyGap = Number(src.match(/minMinutesBetweenAnyPosts:\s*(\d+)/)[1]);
eq("a cross-account gap is enforced", anyGap > 0, true);
eq("cross-account gap is shorter than per-account pacing", anyGap < gap, true);
eq("two accounts are configured", (src.match(/\{ key: "[ab]", label: "[AB]" \}/g) || []).length, 2);
eq("account is passed to the publisher", /account: account \|\| "a"/.test(wsrc), true);
eq("wording is salted per account", /acct\.key === "b" \? 977 : 0/.test(wsrc), true);

if (fails.length) {
  console.log("FAILED:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
console.log(`all checks passed — post structure verified line by line, ${heads.size} headers x ${descs.size} descriptions`);
console.log("\nsample:\n" + out);
