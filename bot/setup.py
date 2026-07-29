"""Turn a parsed Signal into a tradeable setup (entry zone, stop loss, targets).

The channel gives us a price and volume statistics -- it does NOT give levels.
Everything below is derived from the last price using the percentages in
config.json, so tune those to taste.
"""

from dataclasses import dataclass

from .parser import decimals_of


def precision_for(price, ref_raw):
    """Decimals to use for every level in one message -- fixed once, off the last price,
    so a setup never mixes 0.9990 with 1.003."""
    dec = decimals_of(ref_raw)
    # bump precision for very small prices so 0.0000123 doesn't collapse to 0.0000
    while dec < 12 and 0 < price < 10 ** (3 - dec):
        dec += 1
    return dec


def fmt_price(value, dec):
    """Fixed decimals plus thousands separators, e.g. 1905.5 -> '1,905.5'."""
    return f"{value:,.{dec}f}"


@dataclass
class Setup:
    signal: object
    direction: str
    entry_low: str
    entry_high: str
    stop: str
    targets: list          # ["100.50", "104.36", "108.23"]
    rr: str                # "1.6" -- reward:risk to TP2
    ticker: str            # "$AAVE"

    @property
    def emoji(self):
        return "🟢" if self.direction == "LONG" else "🔴"

    @property
    def arrow(self):
        return "📈" if self.direction == "LONG" else "📉"


def build_setup(sig, cfg):
    p, raw = sig.price, sig.price_raw
    zone = cfg["entry_zone_pct"] / 100.0
    sl = cfg["stop_loss_pct"] / 100.0
    tps = cfg["take_profit_pcts"]

    if sig.side == "buy":
        lo, hi = p * (1 - zone / 2), p * (1 + zone / 2)
        stop = p * (1 - sl)
        targets = [p * (1 + t / 100.0) for t in tps]
    else:
        lo, hi = p * (1 - zone / 2), p * (1 + zone / 2)
        stop = p * (1 + sl)
        targets = [p * (1 - t / 100.0) for t in tps]

    # With filters off, BTC/ETH-quoted pairs come through too -- label them so
    # "$ETH at 0.029" reads as the ETH/BTC ratio it actually is.
    ticker = f"${sig.base}" if sig.quote in ("USDT", "USDC", "FDUSD", "TUSD", "USD", "") else f"${sig.base}/{sig.quote}"

    risk = abs(p - stop)
    reward = abs(targets[1] - p) if len(targets) > 1 else abs(targets[0] - p)
    rr = f"{reward / risk:.1f}" if risk else "-"
    dec = precision_for(p, raw)

    return Setup(
        signal=sig,
        direction=sig.direction,
        entry_low=fmt_price(lo, dec),
        entry_high=fmt_price(hi, dec),
        stop=fmt_price(stop, dec),
        targets=[fmt_price(t, dec) for t in targets],
        rr=rr,
        ticker=ticker,
    )
