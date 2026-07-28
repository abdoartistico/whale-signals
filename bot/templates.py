"""Message templates.

Seven layouts are rotated so consecutive posts never look alike, and the
commentary line is picked from a data-driven pool seeded by the message id
(deterministic -- the same alert always renders identically, but neighbouring
alerts read differently).

All templates use Telegram's legacy *Markdown* parse mode.
"""


def money(v, quote="USDT"):
    unit = "$" if quote in ("USDT", "USDC", "USD", "FDUSD", "TUSD") else ""
    suffix = "" if unit else f" {quote}"
    for div, tag in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(v) >= div:
            return f"{unit}{v / div:.2f}{tag}{suffix}"
    if abs(v) < 100:                       # BTC/ETH-quoted pairs need decimals
        return f"{unit}{v:.4g}{suffix}"
    return f"{unit}{v:,.0f}{suffix}"


def _net(sig, tf):
    return sig.net_vol.get(tf)


def _signed(v, d=2):
    return f"{'+' if v > 0 else ''}{v:.{d}f}%"


def _facts(s):
    """Human-readable fragments built from the actual alert data.

    The two sources publish different things, so `stat_line` and `bullets` are
    built per-source; templates use those rather than raw fields, which keeps all
    seven layouts working for both without claiming data that does not exist.
    """
    sig = s.signal
    side_word = "Buy" if sig.side == "buy" else "Sell"
    f = _base_facts(s, sig, side_word)

    if sig.source == "pumpdetector":
        vol_ch = "" if sig.vol_change_pct is None else f" ({_signed(sig.vol_change_pct, 0)})"
        f["stat_line"] = (
            f"📈 Move {f['move']}  ·  Vol {f['vol24']}{vol_ch}"
            + (f"  ·  {sig.exchange}" if sig.exchange else "")
        )
        f["bullets"] = [
            f"Price jumped {f['move']} from ${sig.price_from_raw} to ${sig.price_raw}",
            f"Volume at {f['vol24']}" if sig.vol_change_pct is None
            else f"Volume up {_signed(sig.vol_change_pct, 0)} to {f['vol24']}",
            f"{money(sig.vol_increase, sig.quote)} of fresh volume"
            + (f" on {sig.exchange}" if sig.exchange else ""),
        ]
    else:
        f["stat_line"] = f"📈 24h {f['ch24']:+.2f}%  ·  4h {f['ch4']:+.2f}%  ·  Vol {f['vol24']}"
        pct = lambda v: "n/a" if v is None else f"{v:+.0f}%"  # noqa: E731
        f["bullets"] = [
            f"{f['dom']} {side_word.lower()}-side dominance on {f['vol']} in {f['window']}",
            f"Net volume 15m {pct(f['n15'])} · 1h {pct(f['n1h'])}",
            f"{f['vol24']} traded in 24h · {f['alerts24_txt']} today",
        ]
    return f


def _base_facts(s, sig, side_word):
    return {
        "dom": f"{sig.dominance:.0f}%",
        "side_word": side_word,
        "vol": money(sig.alert_volume, sig.quote),
        "window": sig.window,
        "vol24": money(sig.vol24h, sig.quote),
        "ch24": sig.change.get("24h", 0.0),
        "ch4": sig.change.get("4h", 0.0),
        "ch1": sig.change.get("1h", 0.0),
        "n15": _net(sig, "15m"),
        "n1h": _net(sig, "1h"),
        "n4h": _net(sig, "4h"),
        "alerts4": sig.alerts_4h,
        "alerts24": sig.alerts_24h,
        "move": _signed(sig.price_move_pct or 0.0),
        "alerts4_txt": _plural(sig.alerts_4h, f"{side_word.lower()} alert"),
        "alerts24_txt": _plural(sig.alerts_24h, "alert"),
    }


def _plural(n, word):
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


LONG_NOTES = [
    "{side_word} orders took {dom} of a {vol} sweep in {window}. Net volume is holding positive, and buyers keep stepping in above support.",
    "A {vol} buy-side sweep hit in {window} with {dom} of it on the bid. Momentum is building while the {ch24:+.2f}% daily trend stays intact.",
    "Buyers absorbed the offer with {dom} dominance on {vol} traded in {window}. As long as the entry zone holds, continuation stays on the table.",
    "Aggressive accumulation: {dom} of {vol} in {window} came from the buy side. Net volume turned positive on the 15m and 1h.",
    "Demand is showing up — {vol} in {window}, {dom} of it buying. Price is defending the level and the higher-timeframe trend is still up.",
    "Repeat interest — {alerts4_txt} on this pair in the last 4h, the latest {vol} at {dom} dominance. Clustered demand often precedes expansion.",
    "Order flow flipped bullish: {dom} buy-side on {vol} in {window}, against {vol24} of daily turnover. Watching for follow-through.",
    "Strength after the pullback. Buyers defended the zone with {vol} of demand in {window} and net volume stayed green.",
]

SHORT_NOTES = [
    "{side_word} orders took {dom} of a {vol} dump in {window}. Sellers are in control while price stays under the entry zone.",
    "A {vol} sell-side sweep hit in {window}, {dom} of it offered. Supply is heavy and the bounce is being sold.",
    "Distribution showing: {dom} of {vol} in {window} came from sellers. Net volume is negative and rallies keep failing.",
    "Sellers pressed {vol} through the book in {window} with {dom} dominance. Momentum stays down unless the stop level reclaims.",
    "Heavy offer into strength — {vol} in {window}, {dom} selling, against {vol24} of daily volume. Continuation lower is favoured.",
    "Persistent supply — {alerts4_txt} on this pair in the last 4h, the latest {vol} at {dom} dominance. It rarely clears in one move.",
    "Bearish order flow: {dom} sell-side on {vol} in {window}. Price is losing the level and buyers are not defending it.",
    "Rejection from the zone. {vol} of supply in {window} with {dom} on the ask, and net volume rolled over.",
]


# The pump channel publishes no order-flow data, so it gets commentary that only
# claims what its messages actually contain.
PUMP_NOTES = [
    "Price jumped {move} on {vol24} of volume. Momentum is live — the move is already underway, so the entry zone matters more than usual.",
    "Sharp expansion: {move} with volume at {vol24}. Buyers are paying up, and continuation depends on this level holding.",
    "Volume-driven breakout, {move} with fresh participation stepping in. Watch for a hold above the entry zone rather than chasing the wick.",
    "A {move} impulse backed by real turnover. Strong moves often extend, but late entries carry the most risk — respect the stop.",
    "Buyers took control fast: {move} on {vol24}. If price consolidates above the zone instead of fading, continuation is on the table.",
    "Fresh volume is driving this {move} move. Interest is clearly picking up, though the first leg has already played out.",
    "Breakout in progress — {move} with volume confirming. The zone below is where the move either holds or fails.",
    "Momentum ignition: {move}, volume expanding. Treat the entry zone as the line in the sand for this setup.",
]

DUMP_NOTES = [
    "Price broke down {move} on {vol24} of volume. Sellers are in control and bounces are being absorbed.",
    "Sharp flush: {move} with volume at {vol24}. Supply is heavy and the level below is now resistance.",
    "Volume-driven breakdown, {move}. Momentum is lower while price stays beneath the entry zone.",
    "A {move} impulse to the downside backed by real turnover. Late shorts carry the most risk — respect the stop.",
]


def note_for(s, seed):
    if s.signal.source == "pumpdetector":
        pool = PUMP_NOTES if s.direction == "LONG" else DUMP_NOTES
    else:
        pool = LONG_NOTES if s.direction == "LONG" else SHORT_NOTES
    return pool[seed % len(pool)].format(**_facts(s))


# --- templates ----------------------------------------------------------------
# Each takes (setup, note) and returns the finished message string.

def t_boxed(s, note):
    return (
        f"◆ *{s.ticker}* ({s.direction}) {s.emoji}\n"
        f"───────────────────\n"
        f"📍 *Entry Zone* : {s.entry_low} – {s.entry_high}\n"
        f"🛡️ *Stop Loss*  : {s.stop}\n\n"
        f"🎯 *Take Profit Targets:*\n"
        f"✦ *TP1* : {s.targets[0]}\n"
        f"✦ *TP2* : {s.targets[1]}\n"
        f"✦ *TP3* : {s.targets[2]}\n\n"
        f"💡 {note}\n"
        f"───────────────────\n"
        f"*{s.ticker}*"
    )


def t_plain(s, note):
    verb = "Breaking above" if s.direction == "LONG" else "Losing"
    tail = "could unlock further upside" if s.direction == "LONG" else "opens the door to further downside"
    word = "Long" if s.direction == "LONG" else "Short"
    return (
        f"{s.ticker} — {verb} {s.targets[0]} {tail}.\n\n"
        f"{word} {s.ticker}\n\n"
        f"Entry: {s.entry_low}–{s.entry_high}\n"
        f"SL: {s.stop}\n\n"
        f"TP1: {s.targets[0]}\n"
        f"TP2: {s.targets[1]}\n"
        f"TP3: {s.targets[2]}\n\n"
        f"{note}\n\n"
        f"Trade here 👇\n\n"
        f"{s.ticker}"
    )


def t_rocket(s, note):
    lead = "🚀" if s.direction == "LONG" else "⚡"
    return (
        f"{lead} *{s.ticker} {s.direction} SETUP* {s.arrow}🔥\n\n"
        f"Entry: {s.entry_low}–{s.entry_high}\n\n"
        f"🎯 *Take Profit Targets*\n"
        f"1️⃣ TP1: {s.targets[0]}\n"
        f"2️⃣ TP2: {s.targets[1]}\n"
        f"3️⃣ TP3: {s.targets[2]}\n\n"
        f"🛡️ SL: {s.stop}\n\n"
        f"━━━━━━━━━━━━━━\n\n"
        f"📊 {note}\n\n"
        f"Trade here 👇\n\n"
        f"{s.ticker}"
    )


def t_headline(s, note):
    hook = (
        "Buyers are defending support, more upside possible"
        if s.direction == "LONG"
        else "Sellers are capping every bounce, more downside possible"
    )
    word = "Long" if s.direction == "LONG" else "Short"
    return (
        f"🚀 *{s.ticker} — {hook}* {s.arrow}🔥\n\n"
        f"{word} {s.ticker} {s.emoji}\n\n"
        f"Entry: {s.entry_low}–{s.entry_high}\n\n"
        f"🎯 Take Profit:\n"
        f"TP1: {s.targets[0]}\n"
        f"TP2: {s.targets[1]}\n"
        f"TP3: {s.targets[2]}\n\n"
        f"🛡️ SL: {s.stop}\n\n"
        f"{note}\n\n"
        f"Trade here 👇\n\n"
        f"{s.ticker}"
    )


def t_card(s, note):
    f = _facts(s)
    return (
        f"╭━━━ *TRADE IDEA* ━━━╮\n"
        f"  {s.ticker}   ·   *{s.direction}* {s.emoji}\n"
        f"╰━━━━━━━━━━━━━━━╯\n\n"
        f"`Entry `  {s.entry_low} – {s.entry_high}\n"
        f"`Stop  `  {s.stop}\n"
        f"`TP1   `  {s.targets[0]}\n"
        f"`TP2   `  {s.targets[1]}\n"
        f"`TP3   `  {s.targets[2]}\n"
        f"`R:R   `  1 : {s.rr}\n\n"
        f"{f['stat_line']}\n\n"
        f"{note}\n\n"
        f"*{s.ticker}*"
    )


def t_checklist(s, note):
    f = _facts(s)
    bullets = "\n".join(f"✅ {b}" for b in f["bullets"])
    return (
        f"{s.emoji} *{s.ticker} · {s.direction}*\n\n"
        f"*Why this setup:*\n"
        f"{bullets}\n\n"
        f"*The plan:*\n"
        f"📍 Entry  {s.entry_low} – {s.entry_high}\n"
        f"🛡️ Stop   {s.stop}\n"
        f"🎯 Targets {s.targets[0]} → {s.targets[1]} → {s.targets[2]}\n"
        f"⚖️ R:R    1 : {s.rr}\n\n"
        f"{note}\n\n"
        f"{s.ticker}"
    )


def t_minimal(s, note):
    word = "LONG" if s.direction == "LONG" else "SHORT"
    return (
        f"*{word} {s.ticker}*\n\n"
        f"Entry {s.entry_low} – {s.entry_high}\n"
        f"Stop  {s.stop}\n"
        f"Targets {s.targets[0]} / {s.targets[1]} / {s.targets[2]}\n"
        f"R:R 1:{s.rr}\n\n"
        f"{note}"
    )


TEMPLATES = [t_boxed, t_plain, t_rocket, t_headline, t_card, t_checklist, t_minimal]
TEMPLATE_NAMES = [f.__name__[2:] for f in TEMPLATES]


def render(s, index, seed=None):
    """Render setup `s` with template #index (rotating) and a varied commentary line."""
    tpl = TEMPLATES[index % len(TEMPLATES)]
    seed = seed if seed is not None else s.signal.msg_id
    return tpl(s, note_for(s, seed))
