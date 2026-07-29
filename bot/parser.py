"""Parse WhaleTracker channel messages into structured signals.

Source format (one message = one alert):

    ┌ #AAVEUSDT ✳️ Buying Volume
    ├ 171.12K ₮ volume in 1m
    ┊├ Buy [85%]: 145.63K ₮
    ┊└ Sell [-15%]: -25.48K ₮
    ├Price: 96.14→96.23 (0.1%)
    ├Change: 24h[5.25%] 4h[0.42%]
    ┊└ 15m[-0.34%] 1h[-0.04%]
    ├24h Volume: 13.421M ₮
    ┊├ Buy [49%]: 6.661M ₮
    ┊└ Sell [-51%]: -6.760M ₮
    ├Net Vol: 15m[7%] 1h[6%] 4h[2%]
    └Alerts: 24h[2] 4h[1]
"""

import html
import re
import urllib.request
from dataclasses import dataclass, field

WEB_PREVIEW = "https://t.me/s/{channel}"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"

_SUFFIX = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}


def to_number(raw):
    """'171.12K' -> 171120.0, '-6.760M' -> -6760000.0, '96.14' -> 96.14."""
    if raw is None:
        return None
    s = raw.strip().replace(",", "").replace("−", "-")
    mult = 1.0
    if s and s[-1].upper() in _SUFFIX:
        mult = _SUFFIX[s[-1].upper()]
        s = s[:-1]
    try:
        return float(s) * mult
    except ValueError:
        return None


def decimals_of(raw):
    """How many decimal places the channel printed, so our levels match its precision."""
    return len(raw.split(".")[1]) if "." in raw else 0


@dataclass
class Signal:
    msg_id: int = 0
    source: str = "whaletracker"
    symbol: str = ""              # AAVEUSDT
    base: str = ""                # AAVE
    quote: str = ""               # USDT / BTC
    side: str = ""                # "buy" | "sell"
    alert_volume: float = 0.0     # quote-currency volume in the alert window
    window: str = ""              # "1m", "45s", "11s"
    buy_pct: float = 0.0
    sell_pct: float = 0.0
    price_open: float = 0.0
    price: float = 0.0            # close price -> what we build the setup from
    price_raw: str = ""           # keep the string for precision matching
    price_move_pct: float = 0.0
    change: dict = field(default_factory=dict)   # {"24h": 5.25, "4h": .42, "15m": ..., "1h": ...}
    vol24h: float = 0.0
    vol24h_buy_pct: float = 0.0
    vol24h_sell_pct: float = 0.0
    net_vol: dict = field(default_factory=dict)  # {"15m": 7, "1h": 6, "4h": 2}
    alerts_24h: int = 0
    alerts_4h: int = 0
    raw: str = ""
    # cointrendz_pumpdetector only
    exchange: str = ""
    price_from: float = 0.0
    price_from_raw: str = ""
    vol_change_pct: float = None
    vol_increase: float = 0.0

    @property
    def direction(self):
        return "LONG" if self.side == "buy" else "SHORT"

    @property
    def dominance(self):
        """Strength of the dominant side, 0-100."""
        return self.buy_pct if self.side == "buy" else abs(self.sell_pct)


# --- individual field patterns -------------------------------------------------
_RE_HEAD = re.compile(r"#([A-Z0-9]+)\s*(?:\S+\s*)?(Buying|Selling)\s+Volume", re.I)
_RE_ALERT_VOL = re.compile(r"^├\s*([\d.,]+[KMBT]?)\s*(\S+)\s+volume in\s+(\S+)", re.M)
_RE_BUY = re.compile(r"Buy\s*\[(-?[\d.]+)%\]")
_RE_SELL = re.compile(r"Sell\s*\[(-?[\d.]+)%\]")
_RE_PRICE = re.compile(r"Price:\s*([\d.,]+)\s*→\s*([\d.,]+)\s*\((-?[\d.]+)%\)")
_RE_CHANGE = re.compile(r"(24h|4h|15m|1h)\[(-?[\d.]+)%\]")
_RE_VOL24 = re.compile(r"24h Volume:\s*([\d.,]+[KMBT]?)")
_RE_NETVOL = re.compile(r"Net Vol:\s*(.+)")
_RE_ALERTS = re.compile(r"Alerts:\s*24h\[(\d+)\]\s*4h\[(\d+)\]")

QUOTE_SYMBOLS = {"₮": "USDT", "Ƀ": "BTC", "Ξ": "ETH", "$": "USD"}


def parse_message(text, msg_id=0):
    """Return a Signal, or None if the text isn't a WhaleTracker volume alert."""
    head = _RE_HEAD.search(text)
    if not head:
        return None

    sig = Signal(msg_id=msg_id, raw=text)
    sig.symbol = head.group(1).upper()
    sig.side = "buy" if head.group(2).lower() == "buying" else "sell"

    # split symbol into base/quote
    for q in ("USDT", "USDC", "FDUSD", "TUSD", "BTC", "ETH", "BNB", "EUR", "TRY"):
        if sig.symbol.endswith(q) and len(sig.symbol) > len(q):
            sig.base, sig.quote = sig.symbol[: -len(q)], q
            break
    else:
        sig.base, sig.quote = sig.symbol, ""

    m = _RE_ALERT_VOL.search(text)
    if m:
        sig.alert_volume = to_number(m.group(1)) or 0.0
        sig.window = m.group(3)
        if not sig.quote:
            sig.quote = QUOTE_SYMBOLS.get(m.group(2), "")

    # first Buy[..]/Sell[..] pair belongs to the alert window; the second to 24h volume
    buys = _RE_BUY.findall(text)
    sells = _RE_SELL.findall(text)
    if buys:
        sig.buy_pct = float(buys[0])
    if sells:
        sig.sell_pct = float(sells[0])
    if len(buys) > 1:
        sig.vol24h_buy_pct = float(buys[1])
    if len(sells) > 1:
        sig.vol24h_sell_pct = float(sells[1])

    m = _RE_PRICE.search(text)
    if not m:
        return None  # no price -> we cannot build a setup
    sig.price_raw = m.group(2)
    sig.price_open = to_number(m.group(1)) or 0.0
    sig.price = to_number(m.group(2)) or 0.0
    sig.price_move_pct = float(m.group(3))
    if sig.price <= 0:
        return None

    # Change block: the two lines between "Change:" and "24h Volume:"
    change_block = text.split("Change:")[1].split("24h Volume:")[0] if "Change:" in text else ""
    sig.change = {k: float(v) for k, v in _RE_CHANGE.findall(change_block)}

    m = _RE_VOL24.search(text)
    if m:
        sig.vol24h = to_number(m.group(1)) or 0.0

    m = _RE_NETVOL.search(text)
    if m:
        sig.net_vol = {k: float(v) for k, v in _RE_CHANGE.findall(m.group(1))}

    m = _RE_ALERTS.search(text)
    if m:
        sig.alerts_24h, sig.alerts_4h = int(m.group(1)), int(m.group(2))

    return sig


# --- cointrendz_pumpdetector ---------------------------------------------------
# Format:
#   🚀 Pump - REZ/USDT [Binance]
#   Pump Activity on REZ/USDT 🟢🟢
#   💰Price: $0.00262 ➜ $0.00296 (+13.11%)
#   📊Volume: $1.85M (+137.42%)
#   Volume increased by $1.07M ⬆
#
# These fire AFTER the move, so price_move_pct is typically large. Promotional posts
# carry no price line and fall out as None.
_RE_PD_HEAD = re.compile(r"(Pump|Dump)\s*-\s*([A-Z0-9]+)/([A-Z]+)\s*(?:\[([^\]]+)\])?", re.I)
_RE_PD_PRICE = re.compile(r"Price:\s*\$?([\d.,]+)\s*(?:➜|->|→)\s*\$?([\d.,]+)\s*\(([-+]?[\d.]+)%\)")
_RE_PD_VOL = re.compile(r"Volume:\s*\$?([\d.,]+[KMBT]?)\s*(?:\(([-+]?[\d.]+)%\))?")
_RE_PD_VOLINC = re.compile(r"Volume (?:increased|decreased) by\s*\$?([\d.,]+[KMBT]?)", re.I)


def parse_pump_detector(text, msg_id=0):
    """Return a Signal for a cointrendz_pumpdetector alert, or None."""
    head = _RE_PD_HEAD.search(text)
    if not head:
        return None
    price = _RE_PD_PRICE.search(text)
    if not price:
        return None

    sig = Signal(msg_id=msg_id, source="pumpdetector", raw=text)
    sig.base = head.group(2).upper()
    sig.quote = head.group(3).upper()
    sig.exchange = head.group(4) or ""
    sig.symbol = sig.base + sig.quote
    sig.side = "buy" if head.group(1).lower() == "pump" else "sell"

    sig.price_from_raw = price.group(1)
    sig.price_raw = price.group(2)
    sig.price_from = to_number(price.group(1)) or 0.0
    sig.price = to_number(price.group(2)) or 0.0
    sig.price_move_pct = float(price.group(3))
    if sig.price <= 0:
        return None

    vol = _RE_PD_VOL.search(text)
    if vol:
        sig.vol24h = to_number(vol.group(1)) or 0.0
        sig.vol_change_pct = float(vol.group(2)) if vol.group(2) is not None else None

    inc = _RE_PD_VOLINC.search(text)
    sig.vol_increase = (to_number(inc.group(1)) or 0.0) if inc else 0.0
    sig.alert_volume = sig.vol_increase
    return sig


PARSERS = {"whaletracker": parse_message, "pumpdetector": parse_pump_detector}
# Only WhaleTracker is active. parse_pump_detector above is kept and tested but dormant --
# re-enable by adding {"key": "pumpdetector", "channel": "cointrendz_pumpdetector"} here.
SOURCES = [{"key": "whaletracker", "channel": "WhaleTracker"}]


# --- channel scraping ----------------------------------------------------------
_RE_POST = re.compile(
    r'data-post="[^"/]+/(\d+)".*?'
    r'<div class="tgme_widget_message_text js-message_text"[^>]*>(.*?)</div>',
    re.S,
)


def _strip_html(fragment):
    t = re.sub(r"<br\s*/?>", "\n", fragment)
    t = re.sub(r"</?(?:tg-emoji|i|b|a|span|code|pre|s|u)\b[^>]*>", "", t)
    t = re.sub(r"<[^>]+>", "", t)
    return html.unescape(t).strip()


def fetch_page(channel, before=None, timeout=30):
    """Fetch one page of the public web preview. Returns [(msg_id, text), ...] oldest-first."""
    url = WEB_PREVIEW.format(channel=channel)
    if before:
        url += f"?before={before}"
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "en"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode("utf-8", "replace")
    return [(int(mid), _strip_html(frag)) for mid, frag in _RE_POST.findall(body)]


def fetch_new_messages(channel, since_id=0, max_pages=3):
    """Walk back through preview pages until we reach since_id (or run out of pages)."""
    collected, before, seen_ids = {}, None, set()
    for _ in range(max_pages):
        page = fetch_page(channel, before=before)
        if not page:
            break
        fresh = [(i, t) for i, t in page if i > since_id]
        for i, t in fresh:
            collected[i] = t
        ids = [i for i, _ in page]
        # stop once the page reaches back past since_id, or stops advancing
        if min(ids) <= since_id or since_id == 0 or min(ids) in seen_ids:
            break
        seen_ids.add(min(ids))
        before = min(ids)
    return [(i, collected[i]) for i in sorted(collected)]
