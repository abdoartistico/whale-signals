# Crypto signal bot → Telegram

Reads every alert from two public Telegram channels, turns each one into a formatted trade
setup (entry zone, stop loss, TP1–TP3), and posts it to your own Telegram.

| Source | Format | Rate |
|---|---|---|
| [@WhaleTracker](https://t.me/WhaleTracker) | order-flow volume alerts | ~24/hour |
| [@cointrendz_pumpdetector](https://t.me/cointrendz_pumpdetector) | pump detection | ~1/hour |

The two publish completely different data, so each has its own parser and its own
commentary pool — the pump channel reports no buy/sell dominance or net volume, and the
templates never claim figures a source didn't publish.

> **Production runs on Cloudflare Workers** (`cloudflare/`), every 2 minutes. This Python
> version is the fallback; its GitHub Actions schedule is deliberately removed. See
> `cloudflare/README.md`.

**No server. No paid service. No API keys except a free bot token.**

The source channel is read through Telegram's public web preview (`t.me/s/WhaleTracker`),
so there is no login, no phone number, and no `api_id`/`api_hash` to obtain.

---

## Setup (about 10 minutes)

### 1 — Create the bot

In Telegram, open [@BotFather](https://t.me/BotFather):

```
/newbot
```

Pick a name and a username ending in `bot`. BotFather replies with a token that looks like
`8123456789:AAH8x...`. That is your `TELEGRAM_BOT_TOKEN` — keep it private, anyone with it
controls the bot.

### 2 — Decide where signals land, then get the chat ID

**Option A — into your own channel** (best if you want to share signals with others):
create a channel, then add your bot to it as an **administrator** with "Post Messages"
permission, and post any message in it.

**Option B — straight to you**: open your bot in Telegram and press **Start**.

Then, on your Mac:

```bash
cd ~/Documents/omar
export TELEGRAM_BOT_TOKEN="paste-your-token-here"
python3 chatid.py
```

It prints every chat your bot can see. Copy the id you want — channel ids look like
`-1001234567890`, private chats are a plain positive number. That's your `TELEGRAM_CHAT_ID`.

### 3 — Test it locally before sending anything

```bash
python3 -m bot.main --dry-run --verbose     # prints what it would send
python3 preview.py                          # shows all 7 templates
python3 tests/test_parser.py                # offline checks
```

Send one real message to confirm the wiring:

```bash
export TELEGRAM_CHAT_ID="-1001234567890"
python3 -m bot.main --limit 1
```

### 4 — Put it on GitHub

Create a **public** repository (see the free-tier section below for why public), then:

```bash
cd ~/Documents/omar
git init
git add .
git commit -m "WhaleTracker signal bot"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

> `config.json` and `state.json` are committed on purpose. **Never commit your bot token** —
> it only ever lives in GitHub Secrets and your local shell.

### 5 — Add the secrets

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | the BotFather token |
| `TELEGRAM_CHAT_ID` | the id from step 2 |

### 6 — Turn it on

**Actions** tab → enable workflows if prompted → select **WhaleTracker signals** →
**Run workflow**. Tick *dry run* for a no-send test first; untick it to go live.

After the first manual run the schedule takes over by itself.

---

## How much of this stays free

**All of it, indefinitely — on a public repo.**

| Piece | Cost |
|---|---|
| GitHub Actions on a **public** repo | Free, **unlimited minutes**, no expiry |
| GitHub Actions on a **private** repo | 2,000 min/month free — **not enough**, see below |
| Telegram Bot API | Free, always |
| Reading the source channel | Free — public web page, no account |
| Repo storage | A few KB. Free. |

**Why public matters.** Actions bills each job rounded **up to a full minute**. More
importantly, most of a run is spent *waiting*: Telegram accepts roughly 20 messages per
minute to one chat, so forwarding ~850 alerts/day costs about **43 minutes of runtime per
day — 1,296 min/month — in sending alone**, before any startup overhead.

That floor is why a slower schedule does not rescue a private repo:

| cron | runs/month | msgs/run | job time | billed | min/month | vs 2,000 free |
|---|---|---|---|---|---|---|
| `*/5`  | 8,640 | 3  | 34s  | 1m | 8,640 | over by 6,640 |
| `*/10` | 4,320 | 6  | 43s  | 1m | 4,320 | over by 2,320 |
| `*/30` | 1,440 | 18 | 79s  | 2m | 2,880 | over by 880 |
| `*/60` | 720   | 36 | 133s | 3m | 2,160 | over by 160 |
| `*/120`| 360   | 72 | 241s | 5m | 1,800 | fits — but 2h-old signals |

Checking less often does not send fewer messages; it just sends them in bigger batches, and
the sending is the cost. A private repo only fits the free tier at a 2-hour schedule, which
is useless for trading signals.

A public repo has **no minute limit at all**, so none of this table matters. Your bot token
lives in GitHub **Secrets** — encrypted, invisible to anyone browsing the repo — so making
the code public is safe. Nothing personal is in it.

If you must stay private, the only realistic lever is sending fewer messages: set
`"enable_filters": true` in `config.json` to forward only high-conviction alerts, which cuts
volume by roughly 90% and brings a `*/10` schedule well inside the free tier.

**One thing to know:** GitHub disables scheduled workflows in repos with **60 days of no
activity**. This bot commits `state.json` on every run, which counts as activity, so it keeps
itself alive. If you ever pause it for two months, re-enable it in the Actions tab.

### Timing expectations

Cron is set to `*/5` — **every 5 minutes, the platform minimum**. Because the repo is public
there is no minute quota, so there is no reason to check less often.

GitHub still delays scheduled runs by a further 5–15 minutes when its queues are busy, so a
signal typically reaches you **5–20 minutes after** it fires in the channel. That delay is
inherent to free serverless cron and cannot be tuned away; beating it requires an always-on
server.

Measured over a 5-hour sample (120 messages), the channel averages **~24 alerts/hour
(~570/day)**, arriving in bursts of up to 4 per minute. That is roughly **2 messages per
5-minute run** — about 10x under Telegram's ~20/min ceiling.

Bursts are handled by catch-up, not by sampling: each run processes *every* message since
the last recorded id, paging back up to 80 messages, so a delayed or skipped run loses
nothing.

Note that ~1 in 120 alerts uses a non-Latin ticker (e.g. `#币安人生USDT`). Those are skipped
by design — the ticker pattern only accepts A-Z and 0-9.

---

### Don't want GitHub at all?

The only other genuinely free, serverless option is **Cloudflare Workers**: cron triggers
down to *every 1 minute* (better than Actions' 5-minute floor and with no queue delays),
100,000 requests/day free, and state stored in Workers KV. It needs no repo — you deploy
straight from your Mac with `wrangler deploy`.

The catch: Workers runs JavaScript, so `bot/` would need rewriting in JS. Everything else
here — the parsing rules, the level maths, the seven templates — ports over directly. Say
the word if you want that version instead.

What is *not* an option is skipping the runner entirely. A Telegram bot token is an address
to send messages to, not a machine that runs code. Something has to execute the script on a
schedule.

---

## The seven templates

Messages rotate through seven layouts, and the commentary line is drawn from eight
data-driven variants per direction — so consecutive posts never look like the same bot
output. Rotation state lives in `state.json`.

1. **boxed** — `◆ $TICKER (LONG)` with `───` dividers
2. **plain** — narrative style, "Breaking above X could unlock further upside"
3. **rocket** — `🚀 $TICKER LONG SETUP 📈🔥` with numbered targets
4. **headline** — hook headline plus full setup
5. **card** — `╭━━ TRADE IDEA ━━╮` with monospace level alignment and R:R
6. **checklist** — "Why this setup" evidence bullets from the real volume data
7. **minimal** — sparse, no emoji clutter

Run `python3 preview.py` to see them all. Edit or add templates in `bot/templates.py` —
append your function to the `TEMPLATES` list at the bottom and it joins the rotation.

---

## Configuration — `config.json`

### Levels (this is the important part)

The channel only publishes a **price** and volume statistics. It does **not** publish entry
zones, stops, or targets — the bot calculates those from the last price:

```json
"entry_zone_pct": 0.4,
"stop_loss_pct": 5.0,
"take_profit_pcts": [4.0, 8.0, 12.0]
```

- Entry zone spans 0.4% around the price
- Stop is 5% below (LONG) or above (SHORT)
- Targets sit at 4%, 8% and 12% — giving roughly 1 : 1.6 reward-to-risk at TP2

These are the numbers reverse-engineered from your example messages; the three you sent
weren't consistent with each other, so tune them to your own risk model. Add or remove
entries in `take_profit_pcts` for more or fewer targets.

### Pacing

```json
"max_signals_per_run": 40,      // safety cap so a delayed run can't flood you
"seconds_between_sends": 3,     // gap between messages
"cooldown_minutes_per_coin": 0  // 0 = no cooldown; set e.g. 240 for one signal per coin per 4h
```

To slow the feed down, widen the cron interval rather than dropping signals.

### Filters — off by default

Every alert gets forwarded, as requested. If it ever becomes too noisy, set
`"enable_filters": true` and the thresholds below it start applying (minimum volume,
buy/sell dominance, net-volume agreement, stablecoin exclusion, per-coin cooldown, and
optional whitelist/blacklist). Everything is already wired and tested — it's one flag.

---

## Files

```
bot/parser.py      scrapes the channel, parses alerts into structured data
bot/setup.py       derives entry / stop / targets from the price
bot/templates.py   the 7 layouts + commentary variants
bot/filters.py     optional quality filter (disabled by default)
bot/telegram.py    Bot API client
bot/main.py        the run loop
config.json        all your settings
state.json         last processed message id + template rotation (auto-committed)
preview.py         show all templates
chatid.py          find your chat id
tests/             offline checks against known messages
```

Pure Python standard library — no `pip install`, nothing to keep updated.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `chat not found` | Bot isn't in the channel, or the id is wrong. Re-run `chatid.py`. Channel ids start with `-100`. |
| `not enough rights` | Give the bot **Post Messages** admin permission in the channel. |
| Nothing sends, "fetched 0 new" | Normal — no new alerts since the last run. |
| Workflow not firing | Actions tab → enable workflows. Also check the 60-day inactivity rule above. |
| Messages look wrong | `python3 -m bot.main --dry-run --verbose` locally to see exactly what it builds. |
| Want to replay old alerts | Set `"last_id": 0` in `state.json`. |

---

## A note on the signals themselves

This bot mechanically converts volume alerts into fixed-percentage levels. A volume spike
is one input, not a complete trade thesis, and the stop/target distances are arbitrary
percentages rather than structural levels from the chart. Treat the output as a watchlist
prompt, and size positions accordingly.
