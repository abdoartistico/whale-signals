"""Offline checks against known messages. Run: python3 tests/test_parser.py"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bot import filters
from bot.parser import parse_message, parse_pump_detector
from bot.setup import build_setup
from bot.templates import TEMPLATE_NAMES, TEMPLATES, render

AAVE = """┌ #AAVEUSDT ✳️ Buying Volume
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
└Alerts: 24h[3] 4h[2]"""

ETHBTC = """┌ #ETHBTC 🔴 Selling Volume
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
└Alerts: 24h[8] 4h[2]"""

RLUSD = """┌ #RLUSDUSDT 🔴 Selling Volume
├ 278.94K ₮ volume in 1m
┊├ Buy [0%]: 18.02 ₮
┊└ Sell [-100%]: -278.92K ₮
├Price: 1.001→1.001 (0.0%)
├Change: 24h[-0.01%] 4h[0.00%]
┊└ 15m[-0.01%] 1h[0.00%]
├24h Volume: 20.568M ₮
┊├ Buy [66%]: 13.710M ₮
┊└ Sell [-34%]: -6.858M ₮
├Net Vol: 15m[-28%] 1h[32%] 4h[0%]
└Alerts: 24h[7] 4h[1]"""

CFG = {
    "min_alert_volume": 200000, "min_24h_volume": 5000000, "min_side_dominance": 75,
    "require_net_vol_15m": True, "require_net_vol_1h": True, "max_price_move_pct": 3.0,
    "usdt_pairs_only": True, "exclude_stablecoins": True, "allow_shorts": True,
    "entry_zone_pct": 0.4, "stop_loss_pct": 5.0, "take_profit_pcts": [4.0, 8.0, 12.0],
}

fails = []


def eq(label, got, want):
    if got != want:
        fails.append(f"{label}: got {got!r}, want {want!r}")


# --- parsing ---
a = parse_message(AAVE, 1)
eq("aave.symbol", a.symbol, "AAVEUSDT")
eq("aave.base", a.base, "AAVE")
eq("aave.quote", a.quote, "USDT")
eq("aave.side", a.side, "buy")
eq("aave.alert_volume", a.alert_volume, 203960.0)
eq("aave.window", a.window, "1m")
eq("aave.buy_pct", a.buy_pct, 81.0)
eq("aave.sell_pct", a.sell_pct, -19.0)
eq("aave.price", a.price, 96.63)
eq("aave.price_open", a.price_open, 96.38)
eq("aave.change24h", a.change["24h"], 5.327)
eq("aave.change15m", a.change["15m"], 0.33)
eq("aave.vol24h", a.vol24h, 13910000.0)
eq("aave.vol24h_buy_pct", a.vol24h_buy_pct, 50.0)
eq("aave.netvol", a.net_vol, {"15m": 15.0, "1h": 14.0, "4h": 6.0})
eq("aave.alerts", (a.alerts_24h, a.alerts_4h), (3, 2))
eq("aave.dominance", a.dominance, 81.0)

e = parse_message(ETHBTC, 2)
eq("ethbtc.base", e.base, "ETH")
eq("ethbtc.quote", e.quote, "BTC")
eq("ethbtc.side", e.side, "sell")
eq("ethbtc.alert_volume", e.alert_volume, 1.0013)
eq("ethbtc.dominance", e.dominance, 100.0)

r = parse_message(RLUSD, 3)
eq("rlusd.base", r.base, "RLUSD")
eq("rlusd.netvol_15m", r.net_vol["15m"], -28.0)

eq("non-signal returns None", parse_message("hello world", 4), None)

# --- filtering ---
eq("aave passes", filters.check(a, CFG)[0], True)
eq("ethbtc rejected (BTC quote)", filters.check(e, CFG)[0], False)
eq("rlusd rejected (pegged)", filters.check(r, CFG)[0], False)

opposed = parse_message(AAVE.replace("Net Vol: 15m[15%]", "Net Vol: 15m[-15%]"), 5)
eq("net vol opposing direction rejected", filters.check(opposed, CFG)[0], False)

thin = parse_message(AAVE.replace("├ 203.96K ₮ volume", "├ 20.96K ₮ volume"), 6)
eq("thin alert volume rejected", filters.check(thin, CFG)[0], False)

# --- levels ---
s = build_setup(a, CFG)
eq("setup.direction", s.direction, "LONG")
eq("setup.ticker", s.ticker, "$AAVE")
eq("setup.entry", (s.entry_low, s.entry_high), ("96.44", "96.82"))
eq("setup.stop", s.stop, "91.80")
eq("setup.targets", s.targets, ["100.50", "104.36", "108.23"])
eq("setup.rr", s.rr, "1.6")

ss = build_setup(parse_message(ETHBTC, 2), CFG)
eq("non-stable pair keeps quote in ticker", ss.ticker, "$ETH/BTC")
eq("short stop is above price", float(ss.stop) > e.price, True)
eq("short targets descend", [float(t) for t in ss.targets] == sorted((float(t) for t in ss.targets), reverse=True), True)
eq("small price keeps precision", ss.stop, "0.03079")

# every level in one message shares the same decimal count
decs = {len(x.split(".")[1]) for x in [s.entry_low, s.entry_high, s.stop] + s.targets}
eq("uniform precision", len(decs), 1)

# --- rendering ---
eq("template count", len(TEMPLATES), 3)
eq("template names", TEMPLATE_NAMES, ["setup", "compact", "hook"])

for i, name in enumerate(TEMPLATE_NAMES):
    out = render(s, i, seed=i)
    if not out.strip() or "{" in out or "None" in out:
        fails.append(f"template {name} rendered badly:\n{out}")
    for need in [s.entry_low, s.entry_high, s.stop, *s.targets, s.ticker]:
        if need not in out:
            fails.append(f"template {name} is missing {need}")
    if "👇" not in out:
        fails.append(f"template {name} is missing the CTA")
    if "*" in out or "_" in out:
        fails.append(f"template {name} leaked Markdown")

eq("rotation wraps", render(s, 0, seed=1), render(s, 3, seed=1))
eq("neighbouring alerts differ", render(s, 0, seed=1) == render(s, 1, seed=2), False)

# wording must actually rotate -- a linear stride would repeat every pool length
distinct = {render(s, seed % 3, seed=seed) for seed in range(500)}
eq("500 signals stay varied", len(distinct) >= 350, True)

openers = {render(s, 0, seed=n).split("\n")[2] for n in range(60)}
closers = {render(s, 1, seed=n).split("\n")[6] for n in range(60)}
eq("openers rotate", len(openers) >= 10, True)
eq("closers rotate", len(closers) >= 10, True)
eq("slots decorrelated", len({(render(s, 0, seed=n).split(chr(10))[2],
                              render(s, 1, seed=n).split(chr(10))[6]) for n in range(40)}) >= 30, True)

# SHORT must never say Long
short_sig = parse_message(AAVE.replace("✳️ Buying Volume", "🔴 Selling Volume"), 11)
short_setup = build_setup(short_sig, CFG)
for i, name in enumerate(TEMPLATE_NAMES):
    out = render(short_setup, i, seed=i)
    if "Long" in out or "LONG" in out:
        fails.append(f"template {name} says Long on a SHORT signal:\n{out}")

# --- thousands separators ---
big = parse_message(AAVE.replace("├Price: 96.38→96.63 (0.3%)", "├Price: 1920.5→1910.4 (-0.5%)"), 9)
bs = build_setup(big, CFG)
eq("comma formatting", bs.entry_low, "1,906.6")
eq("no comma on small prices", "," in s.entry_low, False)

# --- second source: cointrendz_pumpdetector ---
PUMP = """🚀 Pump - REZ/USDT [Binance]
Pump Activity on REZ/USDT 🟢🟢
💰Price: $0.00262 ➜ $0.00296 (+13.11%)
📊Volume: $1.85M (+137.42%)
Volume increased by $1.07M ⬆"""

p = parse_pump_detector(PUMP, 100)
eq("pump.base", p.base, "REZ")
eq("pump.quote", p.quote, "USDT")
eq("pump.symbol", p.symbol, "REZUSDT")
eq("pump.exchange", p.exchange, "Binance")
eq("pump.side", p.side, "buy")
eq("pump.direction", p.direction, "LONG")
eq("pump.price_from", p.price_from, 0.00262)
eq("pump.price", p.price, 0.00296)
eq("pump.move", p.price_move_pct, 13.11)
eq("pump.vol24h", p.vol24h, 1850000.0)
eq("pump.vol_change_pct", p.vol_change_pct, 137.42)
eq("pump.vol_increase", p.vol_increase, 1070000.0)
eq("pump.source", p.source, "pumpdetector")

eq("promo post -> None", parse_pump_detector("✨Bot Command Showcase✨\n\nFeatured: /fed", 101), None)
eq("wt msg not parsed as pump", parse_pump_detector(AAVE, 102), None)
eq("pump msg not parsed as wt", parse_message(PUMP, 103), None)

ps = build_setup(p, CFG)
eq("pump ticker", ps.ticker, "$REZ")
eq("pump stop below price", float(ps.stop) < p.price, True)
eq("pump targets ascend", ps.targets == sorted(ps.targets, key=float), True)
eq("pump precision kept", ps.targets[0], "0.003078")

# every template must render the pump source without leaking missing fields
for i, name in enumerate(TEMPLATE_NAMES):
    out = render(ps, i, seed=i)
    if "None" in out or "n/a" in out or "{" in out:
        fails.append(f"pump template {name} leaked a missing field:\n{out}")
    if out.count("*") % 2:
        fails.append(f"pump template {name} unbalanced bold")
    # must not claim order-flow stats this source never publishes
    if "dominance" in out or "Net volume" in out:
        fails.append(f"pump template {name} claims data that does not exist:\n{out}")

if fails:
    print("FAILED:")
    for f in fails:
        print("  -", f)
    sys.exit(1)
print(f"all checks passed ({len(TEMPLATE_NAMES)} templates rendered)")
