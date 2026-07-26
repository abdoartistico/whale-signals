"""Show all templates side by side with a sample signal.  python3 preview.py"""

import json
from pathlib import Path

from bot.parser import parse_message
from bot.setup import build_setup
from bot.templates import TEMPLATE_NAMES, render

SAMPLE = """┌ #AAVEUSDT ✳️ Buying Volume
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

cfg = json.loads((Path(__file__).parent / "config.json").read_text())
s = build_setup(parse_message(SAMPLE, 1), cfg)

for i, name in enumerate(TEMPLATE_NAMES):
    print(f"\n{'─' * 46}\n  TEMPLATE {i + 1}/{len(TEMPLATE_NAMES)}: {name}\n{'─' * 46}")
    print(render(s, i, seed=i))
