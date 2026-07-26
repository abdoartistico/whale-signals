"""Find your TELEGRAM_CHAT_ID.

    export TELEGRAM_BOT_TOKEN="123456:ABC..."
    python3 chatid.py

For a private chat: send your bot any message first, then run this.
For a channel/group: add the bot as an admin, post any message there, then run this.
"""

import os
import sys

from bot.telegram import call, get_me

token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
if not token:
    sys.exit("set TELEGRAM_BOT_TOKEN first:  export TELEGRAM_BOT_TOKEN='123456:ABC...'")

me = get_me(token)
if not me.get("ok"):
    sys.exit(f"bad token: {me.get('description')}")
print(f"bot: @{me['result']['username']}\n")

res = call(token, "getUpdates", {"limit": 100, "allowed_updates": ["message", "channel_post", "my_chat_member"]})
if not res.get("ok"):
    sys.exit(f"getUpdates failed: {res.get('description')}")

seen = {}
for upd in res.get("result", []):
    for key in ("message", "channel_post", "edited_message", "my_chat_member"):
        chat = (upd.get(key) or {}).get("chat")
        if chat:
            seen[chat["id"]] = chat.get("title") or chat.get("username") or chat.get("first_name") or "?"

if not seen:
    print("No chats found.")
    print("  private chat -> open the bot in Telegram and press Start / send it a message")
    print("  channel      -> add the bot as ADMIN, then post any message in the channel")
    print("Then run this again.")
else:
    print("Found these chats — use the id you want as TELEGRAM_CHAT_ID:\n")
    for cid, name in seen.items():
        kind = "channel/group" if str(cid).startswith("-") else "private chat"
        print(f"  {cid:>16}   {name}  ({kind})")
