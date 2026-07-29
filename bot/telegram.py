"""Minimal Telegram Bot API client (stdlib only)."""

import json
import urllib.error
import urllib.request

API = "https://api.telegram.org/bot{token}/{method}"


def call(token, method, payload, timeout=30):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        API.format(token=token, method=method),
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            return json.loads(body)
        except ValueError:
            return {"ok": False, "description": f"HTTP {e.code}: {body[:200]}"}


def send_message(token, chat_id, text, disable_preview=True):
    """Send as plain text -- templates carry no Markdown, so nothing can mis-parse."""
    return call(token, "sendMessage", {
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": disable_preview,
    })


def get_me(token):
    return call(token, "getMe", {})
