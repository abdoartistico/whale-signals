"""WhaleTracker -> formatted trade signals -> your Telegram.

Runs on GitHub Actions (or locally). No server, no API keys beyond a bot token:
the source channel is read through Telegram's public web preview.

    python -m bot.main --dry-run          # print what would be sent
    python -m bot.main --dry-run --all    # ignore filters, show every parsed alert
    python -m bot.main                    # actually send
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

from . import filters, telegram
from .parser import fetch_new_messages, parse_message
from .setup import build_setup
from .templates import TEMPLATE_NAMES, render

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "config.json"
STATE_PATH = ROOT / "state.json"


def load_json(path, default):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except ValueError:
            print(f"warn: {path.name} is not valid JSON, using defaults", file=sys.stderr)
    return default


def save_state(state):
    STATE_PATH.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print instead of sending")
    ap.add_argument("--all", action="store_true", help="bypass the quality filter")
    ap.add_argument("--limit", type=int, default=None, help="override max signals for this run")
    ap.add_argument("--verbose", action="store_true", help="explain every rejection")
    args = ap.parse_args(argv)

    cfg = load_json(CONFIG_PATH, {})
    state = load_json(STATE_PATH, {"last_id": 0, "template_index": 0, "cooldown": {}, "sent_total": 0})

    channel = os.environ.get("SOURCE_CHANNEL") or cfg.get("source_channel", "WhaleTracker")
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    # TELEGRAM_CHAT_ID accepts one id or a comma-separated list, so the same signal
    # can go to your channel and a few private chats at once.
    chat_ids = [c.strip() for c in os.environ.get("TELEGRAM_CHAT_ID", "").split(",") if c.strip()]

    if not args.dry_run and not (token and chat_ids):
        print("error: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set", file=sys.stderr)
        return 2

    last_id = int(state.get("last_id", 0))
    messages = fetch_new_messages(channel, since_id=last_id, max_pages=cfg.get("max_pages", 3))
    print(f"fetched {len(messages)} new message(s) from @{channel} (since id {last_id})")

    now = time.time()
    cooldown = state.get("cooldown", {})
    cd_seconds = cfg.get("cooldown_minutes_per_coin", 240) * 60
    limit = args.limit if args.limit is not None else cfg.get("max_signals_per_run", 3)

    sent, candidates = 0, 0
    highest = last_id

    for msg_id, text in messages:
        highest = max(highest, msg_id)
        sig = parse_message(text, msg_id)
        if not sig:
            continue
        candidates += 1

        if cfg.get("enable_filters", False) and not args.all:
            ok, reason = filters.check(sig, cfg)
            if not ok:
                if args.verbose:
                    print(f"  skip {sig.symbol:<14} {reason}")
                continue

            if cd_seconds:
                last_sent = cooldown.get(sig.base, 0)
                if now - last_sent < cd_seconds:
                    mins = (cd_seconds - (now - last_sent)) / 60
                    if args.verbose:
                        print(f"  skip {sig.symbol:<14} cooldown, {mins:.0f}m left")
                    continue

        if sent >= limit:
            print(f"  hit max_signals_per_run={limit}; remaining alerts skipped this run")
            break

        s = build_setup(sig, cfg)
        idx = state.get("template_index", 0)
        text_out = render(s, idx, seed=msg_id)

        if args.dry_run:
            print(f"\n=== msg {msg_id} · {sig.symbol} · {s.direction} · template '{TEMPLATE_NAMES[idx % len(TEMPLATE_NAMES)]}' ===")
            print(text_out)
        else:
            delivered = 0
            for cid in chat_ids:
                res = telegram.send_message(token, cid, text_out)
                if res.get("ok"):
                    delivered += 1
                else:
                    # one bad recipient (blocked the bot, left the channel) must not
                    # stop delivery to everyone else
                    print(f"  send failed for {sig.symbol} -> {cid}: {res.get('description')}", file=sys.stderr)
            if not delivered:
                continue
            print(f"  sent {sig.symbol} ({s.direction}) as '{TEMPLATE_NAMES[idx % len(TEMPLATE_NAMES)]}' to {delivered}/{len(chat_ids)} chat(s)")
            time.sleep(cfg.get("seconds_between_sends", 3))

        state["template_index"] = idx + 1
        cooldown[sig.base] = now
        sent += 1

    # forget cooldown entries that have long expired
    state["cooldown"] = {k: v for k, v in cooldown.items() if now - v < cd_seconds * 2}
    state["last_id"] = highest
    state["sent_total"] = state.get("sent_total", 0) + (0 if args.dry_run else sent)

    print(f"parsed {candidates} alert(s), {'would send' if args.dry_run else 'sent'} {sent}")

    if not args.dry_run:
        save_state(state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
