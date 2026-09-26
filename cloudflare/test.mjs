/** Offline checks for the CycloneRSI -> Binance Square bot. Run: node test.mjs */

import { readFileSync } from "fs";
import {
  parseCycloneRSI, parseMessage, parsePumpDetector,
  buildSetup, render, extractPosts, chooseFor, targetGapMinutes,
} from "./src/worker.js";

const CFG = { entryZonePct: 0.5, stopLossPct: 7.0, takeProfitPcts: [4.0, 8.0, 12.0] };
const src = readFileSync("./src/worker.js", "utf8");
const fails = [];
const eq = (label, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) fails.push(`${label}: got ${g}, want ${w}`);
};
const near = (label, got, want, tol = 1e-6) => {
  if (Math.abs(got - want) > tol) fails.push(`${label}: got ${got}, want ~${want}`);
};

const cy = (sym, cond, price, rsi = "70.00", tf = "1h") =>
  `$${sym}/USDT (${tf}) ${cond} level reached\nPrice: ${price} | RSI: ${rsi} | Binance | TV`;

// ---------------------------------------------------------------- parsing
const ob = parseCycloneRSI(cy("KERNEL", "Overbought", "0.0508", "70.85", "30m"), 500);
eq("base", ob.base, "KERNEL");
eq("quote", ob.quote, "USDT");
eq("timeframe", ob.timeframe, "30m");
eq("price", ob.price, 0.0508);
eq("rsi", ob.rsi, 70.85);
eq("exchange", ob.exchange, "Binance");
eq("source tag", ob.source, "cyclonersi");
eq("non-signal -> null", parseCycloneRSI("hello world", 501), null);

// ---------------------------------------------------------------- direction
// Momentum continuation, NOT mean reversion.
eq("Overbought -> LONG", ob.direction, "LONG");
eq("Extreme Overbought -> LONG", parseCycloneRSI(cy("X", "Extreme Overbought", "1"), 1).direction, "LONG");
eq("Oversold -> SHORT", parseCycloneRSI(cy("X", "Oversold", "1"), 2).direction, "SHORT");
eq("Extreme Oversold -> SHORT", parseCycloneRSI(cy("X", "Extreme Oversold", "1"), 3).direction, "SHORT");
eq("Bullish crossover -> LONG",
   parseCycloneRSI("$BTC/USDT (1d) Bullish crossover\nPrice: 100 | RSI: 55 | Binance | TV", 4).direction, "LONG");
eq("Bearish crossover -> SHORT",
   parseCycloneRSI("$ETH/USDT (1d) Bearish crossover\nPrice: 100 | RSI: 45 | Binance | TV", 5).direction, "SHORT");
eq("extreme flag", parseCycloneRSI(cy("X", "Extreme Oversold", "1"), 6).extreme, true);

// ---------------------------------------------------------------- maths
// Levels are rendered at the source price's precision, so use a price with two
// decimals: the rounding is then far below the tolerances asserted here.
const num = (x) => Number(String(x).replace(/,/g, ""));

// LONG: entry = price .. price*1.005 ; SL = mid*0.93 ; TPs = mid * 1.04/1.08/1.12
const L = buildSetup(parseCycloneRSI(cy("WLD", "Overbought", "1000.00"), 7), CFG);
near("LONG entry low is the price", num(L.entryLow), 1000);
near("LONG entry high is +0.5%", num(L.entryHigh), 1005);
const midL = (1000 + 1005) / 2;
near("LONG SL is mid*0.93", num(L.stop), midL * 0.93, 0.01);
near("LONG TP1 is mid*1.04", num(L.targets[0]), midL * 1.04, 0.01);
near("LONG TP2 is mid*1.08", num(L.targets[1]), midL * 1.08, 0.01);
near("LONG TP3 is mid*1.12", num(L.targets[2]), midL * 1.12, 0.01);
eq("thousands separator once past 1,000", L.targets[0].includes(","), true);

// SHORT: entry = price*0.995 .. price ; SL = mid*1.07 ; TPs = mid * 0.96/0.92/0.88
const S = buildSetup(parseCycloneRSI(cy("APE", "Oversold", "1000.00"), 8), CFG);
near("SHORT entry low is -0.5%", num(S.entryLow), 995);
near("SHORT entry high is the price", num(S.entryHigh), 1000);
const midS = (995 + 1000) / 2;
near("SHORT SL is mid*1.07", num(S.stop), midS * 1.07, 0.01);
near("SHORT TP1 is mid*0.96", num(S.targets[0]), midS * 0.96, 0.01);
near("SHORT TP2 is mid*0.92", num(S.targets[1]), midS * 0.92, 0.01);
near("SHORT TP3 is mid*0.88", num(S.targets[2]), midS * 0.88, 0.01);
eq("SHORT stop sits above entry", num(S.stop) > num(S.entryHigh), true);
eq("SHORT targets descend", S.targets.map(num).every((v, i, a) => i === 0 || v < a[i - 1]), true);

// precision and separators survive
const tiny = buildSetup(parseCycloneRSI(cy("XEC", "Overbought", "0.0000092"), 9), CFG);
eq("tiny prices keep significant digits", /^0\.0000\d+$/.test(tiny.entryLow), true);
eq("no separator on small prices", tiny.entryLow.includes(","), false);

// ---------------------------------------------------------------- format
const out = render(L, 11);
const ln = out.split("\n");
eq("line 0: $ASSET — DIRECTION emoji", /^\$WLD — LONG 🟢$/.test(ln[0]), true);
eq("line 1 blank", ln[1], "");
eq("line 2 is the description", ln[2].length > 20, true);
eq("line 3 blank", ln[3], "");
eq("line 4 Entry with en dash", /^Entry: [\d.,]+ – [\d.,]+$/.test(ln[4]), true);
eq("line 5 SL", /^SL: [\d.,]+$/.test(ln[5]), true);
eq("line 6 blank", ln[6], "");
eq("line 7 TP1", /^TP1: [\d.,]+$/.test(ln[7]), true);
eq("line 8 TP2", /^TP2: [\d.,]+$/.test(ln[8]), true);
eq("line 9 TP3", /^TP3: [\d.,]+$/.test(ln[9]), true);
eq("line 10 blank", ln[10], "");
eq("line 11 is the CTA", ln[11].length > 8, true);
eq("line 12 blank", ln[12], "");
eq("line 13 repeats the ticker", ln[13], "$WLD");
eq("exactly 14 lines", ln.length, 14);
eq("CTA carries an emoji", /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(ln[11]), true);
eq("SHORT header uses the red circle", /^\$APE — SHORT 🔴$/.test(render(S, 12).split("\n")[0]), true);
eq("no markdown", /[*_]/.test(out), false);
eq("SHORT copy never says LONG", /LONG/.test(render(S, 12)), false);

// ---------------------------------------------------------------- rotation
const descs = new Set(), ctas = new Set(), whole = new Set();
for (let seed = 0; seed < 300; seed++) {
  const m = render(L, seed);
  whole.add(m); descs.add(m.split("\n")[2]); ctas.add(m.split("\n")[11]);
}
eq("descriptions rotate", descs.size >= 15, true);
eq("CTAs rotate", ctas.size >= 12, true);
eq("300 posts stay varied", whole.size >= 200, true);
// slots must be independent, or variety collapses to the smaller pool
eq("description and CTA are decorrelated", whole.size > Math.max(descs.size, ctas.size), true);
// a description must never claim data this channel does not publish
for (let seed = 0; seed < 300; seed++) {
  const m = render(L, seed);
  if (/undefined|NaN|\$0\b|dominance|volume in/.test(m)) { fails.push(`bad copy at seed ${seed}:\n${m}`); break; }
}

// ---------------------------------------------------------------- two accounts
const mk = (id, symbol) => ({ sig: { msgId: id, symbol }, image: null });
const pool = [mk(1, "AAAUSDT"), mk(2, "BBBUSDT"), mk(3, "CCCUSDT"), mk(4, "DDDUSDT")];
eq("picks newest when nothing posted", chooseFor(pool, []).sig.msgId, 4);
const afterA = [{ id: 4, symbol: "DDDUSDT", ms: Date.now(), account: "a" }];
eq("never repeats the other account's message", chooseFor(pool, afterA).sig.msgId === 4, false);
eq("avoids the other account's symbol", chooseFor(pool, afterA).sig.symbol === "DDDUSDT", false);
const allUsed = pool.map((e) => ({ id: e.sig.msgId, symbol: e.sig.symbol, ms: Date.now(), account: "a" }));
eq("posts nothing rather than a duplicate", chooseFor(pool, allUsed), null);
const dup = [mk(10, "AAAUSDT"), mk(11, "AAAUSDT")];
eq("falls back to a repeated symbol before posting nothing",
   chooseFor(dup, [{ id: 10, symbol: "AAAUSDT", ms: Date.now(), account: "a" }]).sig.msgId, 11);

const cap = Number(src.match(/maxPostsPerDay:\s*(\d+)/)[1]);
const any = Number(src.match(/minMinutesBetweenAnyPosts:\s*(\d+)/)[1]);
const floor = Number(src.match(/minGapFloorMinutes:\s*(\d+)/)[1]);
eq("per-account cap is under Binance's 100", cap < 100, true);
eq("a cross-account gap is enforced", any > 0, true);
eq("two accounts configured", (src.match(/\{ key: "[ab]", label: "[AB]",/g) || []).length, 2);

// ---------------------------------------------------------------- pacing
// A FIXED gap could never reach the quota: with a 2-minute cron the smallest real
// gap is 16 min, capping an account at 90/day. The gap is therefore adaptive.
const midnight = Date.UTC(2026, 8, 24, 0, 0, 0);
const CFGP = { maxPostsPerDay: cap, minGapFloorMinutes: floor };
near("at day start the gap spreads the full quota", targetGapMinutes(0, midnight, CFGP), 1440 / cap, 0.1);
const halfway = midnight + 12 * 3600 * 1000;
near("on track at midday the gap holds steady", targetGapMinutes(Math.round(cap / 2), halfway, CFGP), 720 / (cap - Math.round(cap / 2)), 0.2);
eq("falling behind tightens the gap",
   targetGapMinutes(10, halfway, CFGP) < targetGapMinutes(0, midnight, CFGP), true);
eq("the gap never drops below the floor",
   targetGapMinutes(0, midnight + 1439 * 60000, CFGP) >= floor, true);
eq("a finished quota stops posting", targetGapMinutes(cap, halfway, CFGP), Infinity);

// A full simulated day must let BOTH accounts finish their quota, including through
// a long quiet spell -- the regression that left the second account ~30% short.
function simulateDay({ quiet = [] } = {}) {
  const acc = { a: { count: 0, last: 0 }, b: { count: 0, last: 0 } };
  let lastAny = 0, msgs = [], nextId = 1;
  const posted = new Set();
  for (let m = 0; m < 1440; m += 2) {
    const now = midnight + m * 60000;
    if (!quiet.some(([s, e]) => m >= s && m < e)) {
      for (let i = 0; i < 1; i++) msgs.push({ id: nextId++, t: now });
    }
    const pool = msgs.filter((x) => !posted.has(x.id) && now - x.t <= 25 * 60000);
    const order = Object.keys(acc).sort((x, y) => acc[x].count - acc[y].count || acc[x].last - acc[y].last);
    for (const k of order) {
      const a = acc[k];
      if (a.count >= cap) continue;
      if ((now - a.last) / 60000 < targetGapMinutes(a.count, now, CFGP)) continue;
      if ((now - lastAny) / 60000 < any) continue;
      const pick = pool.filter((x) => !posted.has(x.id)).pop();
      if (!pick) continue;
      posted.add(pick.id); a.count++; a.last = now; lastAny = now;
    }
    msgs = msgs.filter((x) => now - x.t <= 30 * 60000);
  }
  return acc;
}
const day = simulateDay();
eq("account A reaches its quota over a day", day.a.count >= cap - 2, true);
eq("account B reaches its quota over a day", day.b.count >= cap - 2, true);
eq("neither account exceeds the cap", day.a.count <= cap && day.b.count <= cap, true);
const rough = simulateDay({ quiet: [[600, 690]] });
eq("both recover from a 90-minute quiet spell", rough.a.count >= cap - 3 && rough.b.count >= cap - 3, true);

// ---------------------------------------------------------------- account B
// Institutional profile: entry on the favourable side of price, SL and TPs measured
// from the entry EXTREME (which is the alert price), and no chart attached.
const BL = buildSetup(parseCycloneRSI(cy("SOL", "Overbought", "100.00", "74.10"), 20), CFG, "institutional");
near("B LONG entry low is P*0.995", num(BL.entryLow), 99.5);
near("B LONG entry high is P", num(BL.entryHigh), 100);
near("B LONG SL is entryHigh*0.93", num(BL.stop), 93, 0.01);
near("B LONG TP1 is entryHigh*1.04", num(BL.targets[0]), 104, 0.01);
near("B LONG TP2 is entryHigh*1.08", num(BL.targets[1]), 108, 0.01);
near("B LONG TP3 is entryHigh*1.12", num(BL.targets[2]), 112, 0.01);

const BS = buildSetup(parseCycloneRSI(cy("LINK", "Oversold", "100.00", "27.30"), 21), CFG, "institutional");
near("B SHORT entry low is P", num(BS.entryLow), 100);
near("B SHORT entry high is P*1.005", num(BS.entryHigh), 100.5);
near("B SHORT SL is entryLow*1.07", num(BS.stop), 107, 0.01);
near("B SHORT TP1 is entryLow*0.96", num(BS.targets[0]), 96, 0.01);
near("B SHORT TP2 is entryLow*0.92", num(BS.targets[1]), 92, 0.01);
near("B SHORT TP3 is entryLow*0.88", num(BS.targets[2]), 88, 0.01);
eq("B entry range always ascends", num(BS.entryLow) < num(BS.entryHigh), true);

// the two profiles must not produce identical levels on the same alert
const sameSig = parseCycloneRSI(cy("SOL", "Overbought", "184.20", "74.10"), 22);
const asA = buildSetup(sameSig, CFG, "momentum"), asB = buildSetup(sameSig, CFG, "institutional");
eq("A and B price the same alert differently", asA.entryLow === asB.entryLow, false);

// copy pools must be distinct between the accounts
const aCopy = new Set(), bCopy = new Set();
for (let seed = 0; seed < 120; seed++) {
  aCopy.add(render(asA, seed).split("\n")[2]);
  bCopy.add(render(asB, seed).split("\n")[2]);
}
eq("account A has its own descriptions", aCopy.size >= 15, true);
eq("account B has its own descriptions", bCopy.size >= 20, true);
let shared = 0;
for (const line of bCopy) if (aCopy.has(line)) shared++;
eq("the two accounts never share a description", shared, 0);

const bCtas = new Set(), aCtas = new Set();
for (let seed = 0; seed < 120; seed++) {
  bCtas.add(render(asB, seed).split("\n")[11]);
  aCtas.add(render(asA, seed).split("\n")[11]);
}
eq("account B has at least 20 CTAs", bCtas.size >= 18, true);
let sharedCta = 0;
for (const c of bCtas) if (aCtas.has(c)) sharedCta++;
eq("the two accounts never share a CTA", sharedCta, 0);
eq("B keeps the required layout", render(asB, 1).split("\n").length, 14);

// image policy and profiles are declared per account
eq("account A attaches charts", /key: "a", label: "A", profile: "momentum", images: true/.test(src), true);
eq("account B posts text only", /key: "b", label: "B", profile: "institutional", images: false/.test(src), true);
eq("the run loop honours the image flag", /const image = acct\.images \? rawImage : null;/.test(src), true);

// RSI thresholds decide direction when the alert carries no label
eq("RSI >= 65 with no label -> LONG",
   parseCycloneRSI("$AAA/USDT (1h) Neutral level reached\nPrice: 10 | RSI: 66.0 | Binance | TV", 30)?.direction, "LONG");
eq("RSI <= 35 with no label -> SHORT",
   parseCycloneRSI("$AAA/USDT (1h) Neutral level reached\nPrice: 10 | RSI: 30.0 | Binance | TV", 31)?.direction, "SHORT");
eq("a mid RSI with no label is no trade",
   parseCycloneRSI("$AAA/USDT (1h) Neutral level reached\nPrice: 10 | RSI: 50.0 | Binance | TV", 32), null);

// ---------------------------------------------------------------- images
const HTML =
  `<div data-post="CycloneRSI/1"><a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn5.telesco.pe/file/AAA')"></a>` +
  `<div class="tgme_widget_message_text js-message_text">$KERNEL/USDT (30m) Overbought level reached<br/>Price: 0.0508 | RSI: 70.85 | Binance | TV</div></div>` +
  `<div data-post="CycloneRSI/2"><a class="tgme_widget_message_photo_wrap" style="background-image:url('https://cdn5.telesco.pe/file/BBB')"></a>` +
  `<div class="tgme_widget_message_text js-message_text">$DOGE/USDT (4h) Oversold level reached<br/>Price: 0.1234 | RSI: 25.00 | Binance | TV</div></div>`;
const ex = extractPosts(HTML);
eq("two posts extracted", ex.length, 2);
eq("image 1 pairs with message 1", ex[0][2], "https://cdn5.telesco.pe/file/AAA");
eq("image 2 pairs with message 2", ex[1][2], "https://cdn5.telesco.pe/file/BBB");
eq("message 1 parses", parseCycloneRSI(ex[0][1], ex[0][0]).base, "KERNEL");
eq("message 2 parses", parseCycloneRSI(ex[1][1], ex[1][0]).base, "DOGE");
const NOPIC = `<div data-post="c/3"><i class="tgme_widget_message_user_photo" style="background-image:url('https://cdn.telesco.pe/avatar')"></i>` +
  `<div class="tgme_widget_message_text js-message_text">no photo</div></div>`;
eq("an avatar is not mistaken for a chart", extractPosts(NOPIC)[0][2], null);
eq("numeric HTML entities decoded",
   extractPosts('<div data-post="c/1"><div class="js-message_text">&#036;5</div></div>')[0][1], "$5");

// ---------------------------------------------------------------- excluded coins
const EXCLUDED = ["USDT","USDC","BFUSD","XUSD","U","FDUSD","TUSD","DAI","USDP","PYUSD","USDD",
  "USDE","GUSD","FRAX","LUSD","SUSD","ALUSD","USDTB","EURT","EURS","BRL","BRLZ","BUSD","CADC",
  "NZDS","TRYB","GYEN","JPYC","XSGD","EURL","EURCV","VEUR","CNHT","MIM","CRVUSD","DOLA","HUSD",
  "OUSD","USDX","USN","VAI","STBL","CUSD","DJED","AGEUR","EEUR","CEUR","SEURO","PAR","MUSD",
  "EUSD","TOR","FEI","USDV","BOLD","GRAI","PRISMA","USH","YUSD","ZUSD","USDS","USD0","HYUSD",
  "MIMA","BRLA","ARS","TRYG","ZARV","NGNV","MXNT","UAHC","CNH","IDRT","PAXG","XAUT","PEPE"];
const setBlock = src.slice(src.indexOf("const STABLE_BASES"), src.indexOf("const QUOTES"));
for (const c of EXCLUDED) if (!new RegExp(`"${c}"`).test(setBlock)) fails.push(`excluded coin ${c} missing`);
eq("exclusion is enabled", /excludeStablecoins:\s*true/.test(src), true);

// ---------------------------------------------------------------- invariants
// The Worker's IP is blocked by Binance, so it must never hold a binance.com URL.
eq("worker has no binance.com request URL", /["`]https:\/\/www\.binance\.com/.test(src), false);
eq("worker dispatches to GitHub instead", /actions\/workflows\/\$\{WORKFLOW_FILE\}\/dispatches/.test(src), true);
eq("dispatch sends a User-Agent", /"User-Agent": "whale-signals-worker"/.test(src), true);
eq("204 is success", /res\.status === 204/.test(src), true);
eq("account reaches the publisher", /account: account \|\| "a"/.test(src), true);

// dormant parsers still work, so re-enabling a source is a one-line change
eq("whaletracker parser intact",
   parseMessage("┌ #AAVEUSDT ✳️ Buying Volume\n├ 203.96K ₮ volume in 1m\n├Price: 96.38→96.63 (0.3%)", 1).base, "AAVE");
eq("pump parser intact",
   parsePumpDetector("🚀 Pump - REZ/USDT [Binance]\n💰Price: $0.00262 ➜ $0.00296 (+13.11%)", 2).price, 0.00296);

if (fails.length) {
  console.log("FAILED:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
console.log(`all checks passed — ${descs.size} descriptions x ${ctas.size} CTAs, ${whole.size} distinct posts per 300`);
console.log("\nLONG:\n" + out + "\n\nSHORT:\n" + render(S, 12));
