"""Quality filter -- the channel fires constantly, this decides what is worth posting."""

# Pegged assets: a 12% target on a $1.00 coin is not a trade.
STABLE_BASES = {
    "USDT", "USDC", "RLUSD", "FDUSD", "TUSD", "BUSD", "DAI", "USDE", "USDD",
    "PYUSD", "USDP", "FRAX", "LUSD", "GUSD", "EURI", "EURT", "EURS", "USD1",
    "USDS", "SUSD", "CRVUSD", "USDG", "USDY", "BSC-USD",
}


def check(sig, cfg):
    """Return (passed: bool, reason: str)."""
    if cfg.get("usdt_pairs_only", True) and sig.quote not in ("USDT", "USDC", "FDUSD", "TUSD"):
        return False, f"quote {sig.quote or '?'} not in stablecoin pairs"

    if cfg.get("exclude_stablecoins", True) and sig.base in STABLE_BASES:
        return False, "pegged asset"

    if sig.side == "sell" and not cfg.get("allow_shorts", True):
        return False, "shorts disabled"

    if sig.base in cfg.get("blacklist", []):
        return False, "blacklisted"

    wl = cfg.get("whitelist") or []
    if wl and sig.base not in wl:
        return False, "not in whitelist"

    if sig.alert_volume < cfg["min_alert_volume"]:
        return False, f"alert volume {sig.alert_volume:,.0f} < {cfg['min_alert_volume']:,.0f}"

    if sig.vol24h < cfg["min_24h_volume"]:
        return False, f"24h volume {sig.vol24h:,.0f} < {cfg['min_24h_volume']:,.0f}"

    if sig.dominance < cfg["min_side_dominance"]:
        return False, f"dominance {sig.dominance:.0f}% < {cfg['min_side_dominance']}%"

    # net volume must agree with the direction of the alert
    want_positive = sig.side == "buy"
    for tf, key in (("15m", "require_net_vol_15m"), ("1h", "require_net_vol_1h"), ("4h", "require_net_vol_4h")):
        if not cfg.get(key):
            continue
        nv = sig.net_vol.get(tf)
        if nv is None:
            return False, f"net vol {tf} missing"
        if (nv <= 0) if want_positive else (nv >= 0):
            return False, f"net vol {tf} = {nv:+.0f}% opposes {sig.direction}"

    mx = cfg.get("max_price_move_pct")
    if mx and abs(sig.price_move_pct) > mx:
        return False, f"price already moved {sig.price_move_pct:+.1f}% in the window"

    mn = cfg.get("min_alerts_4h")
    if mn and sig.alerts_4h < mn:
        return False, f"only {sig.alerts_4h} alerts in 4h < {mn}"

    return True, "ok"
