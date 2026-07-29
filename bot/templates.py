"""Message templates.

Three layouts. Each pulls its wording from rotating pools so consecutive posts never
read the same: an opener/hook, a closing sentiment line, a call to action, and (for the
SETUP layout) a follow line.

3 layouts x 24 openers x 24 closers x 6 CTAs x 4 follow lines -- roughly 400 distinct
messages per 500 signals in practice. Selection is seeded off the message id, so it is
deterministic but decorrelated per slot.

Plain text on purpose: no Markdown markers, so nothing can mis-parse on odd tickers.
"""

LONG_OPENERS = [
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
]

SHORT_OPENERS = [
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
]

LONG_CLOSERS = [
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
]

SHORT_CLOSERS = [
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
]

CTAS = [
    "Open your trade 👇",
    "Trade from here 👇",
    "Trade here 👇",
    "Enter from here 👇",
    "Take the setup here 👇",
    "Start your trade 👇",
]

FOLLOW_LINES = [
    "✅ Follow for more high-quality trade setups.",
    "✅ Follow for more setups like this.",
    "✅ More high-quality setups posted daily.",
    "✅ Stay tuned for more premium setups.",
]


def _hash32(x):
    """Mirror of the Worker's hash32 so both implementations pick identically."""
    x &= 0xFFFFFFFF
    x = (x ^ 61) ^ (x >> 16)
    x = (x + (x << 3)) & 0xFFFFFFFF
    x ^= x >> 4
    x = (x * 0x27D4EB2D) & 0xFFFFFFFF
    x ^= x >> 15
    return x & 0xFFFFFFFF


def _pick(pool, seed, salt):
    """Independent draw per slot.

    A linear stride (seed * salt) looks varied but makes the slots move in lockstep, so
    the whole message repeats with a period equal to the pool size. Hashing avoids that.
    """
    mixed = ((seed * 0x9E3779B1) & 0xFFFFFFFF) + ((salt * 0x85EBCA6B) & 0xFFFFFFFF)
    return pool[_hash32(mixed) % len(pool)]


def parts_for(s, seed):
    long = s.direction == "LONG"
    return {
        "opener": _pick(LONG_OPENERS if long else SHORT_OPENERS, seed, 1),
        "closer": _pick(LONG_CLOSERS if long else SHORT_CLOSERS, seed, 7),
        "cta": _pick(CTAS, seed, 13),
        "follow": _pick(FOLLOW_LINES, seed, 5),
    }


# --- templates ----------------------------------------------------------------
# Each takes (setup, parts) and returns the finished message.

def t_setup(s, p):
    return (
        f"🔥 {s.direction} SETUP — {s.ticker}\n\n"
        f"💎 {p['opener']}\n\n"
        f"Entry Zone: {s.entry_low} – {s.entry_high}\n\n"
        f"🛡️ Stop Loss: {s.stop}\n\n"
        f"🎯 Take Profit:\n"
        f" TP1: {s.targets[0]}\n"
        f" TP2: {s.targets[1]}\n"
        f" TP3: {s.targets[2]}\n\n"
        f"{p['follow']}\n\n"
        f"{p['cta']}\n\n"
        f"{s.ticker}"
    )


def t_compact(s, p):
    return (
        f"{s.ticker} — {s.direction} {s.emoji}\n"
        f"Entry: {s.entry_low} – {s.entry_high}\n"
        f"SL: {s.stop}\n"
        f"TP1: {s.targets[0]}\n"
        f"TP2: {s.targets[1]}\n"
        f"TP3: {s.targets[2]}\n"
        f"{p['closer']}\n"
        f"{p['cta']}\n"
        f"{s.ticker}"
    )


def t_hook(s, p):
    word = "Long" if s.direction == "LONG" else "Short"
    return (
        f"{s.ticker} – {p['opener']}\n"
        f"{word} {s.ticker}\n"
        f"Entry: {s.entry_low} – {s.entry_high}\n"
        f"SL: {s.stop}\n"
        f"TP1: {s.targets[0]}\n"
        f"TP2: {s.targets[1]}\n"
        f"TP3: {s.targets[2]}\n"
        f"{p['closer']}\n"
        f"{p['cta']}\n"
        f"{s.ticker}"
    )


TEMPLATES = [t_setup, t_compact, t_hook]
TEMPLATE_NAMES = [f.__name__[2:] for f in TEMPLATES]


def render(s, index, seed=None):
    """Render setup `s` with template #index (rotating) and seeded wording."""
    seed = seed if seed is not None else s.signal.msg_id
    return TEMPLATES[index % len(TEMPLATES)](s, parts_for(s, seed))
