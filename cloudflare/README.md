# Cloudflare Workers version

**Destination: Binance Square** (not Telegram). Reads @WhaleTracker, builds a trade setup,
and publishes it with the Square OpenAPI.

    POST https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add
    X-Square-OpenAPI-Key: <key>     clienttype: binanceSkill
    { "contentType": 1, "bodyTextOnly": "<post>" }
    success when code === "000000"; a 504 means published-without-id -- never retry it

## Rate limiting (the important part)

Binance Square allows **100 posts/day**. WhaleTracker produces **~670 alerts/day**, so only
about 1 in 7 can be published. Rather than burning the quota in the first few hours and
going silent, posting is paced:

| Control | Value | Effect |
|---|---|---|
| `minMinutesBetweenPosts` | 15 | at most 96 posts/day -- the cap cannot be reached |
| `maxPostsPerDay` | 95 | hard stop, belt and braces |
| choice within a window | newest eligible signal | the most tradable one, not the stalest |

The daily counter lives in KV and resets on the UTC date rollover, matching Binance's reset.
Alerts skipped by pacing are dropped, not queued -- a signal held behind a rate limit is
stale by the time it could be sent.

## Excluded coins

Pegged assets are filtered out (`excludeStablecoins: true`): USDT, USDC, FDUSD, TUSD, USDP,
USDD, DAI, EURI, EURT, AEUR, PYUSD, GUSD, FRAX, LUSD, SUSD, MUSD, USDX, CEUR, XSGD, TRYB,
BRLZ, plus RLUSD, BUSD, USDE, USD1, USDS, CRVUSD, USDG, USDY, EURS.

## Post format

One fixed structure; the header and description rotate (24 headers x 20 description
templates per direction, and descriptions interpolate the alert's real order-flow numbers):

    $SUI — LONG setup demand surging, targets in sight🎯

    Entry: 0.6848 - 0.6876
    SL: 0.6382

    TP1: 0.7137
    TP2: 0.7411
    TP3: 0.7686

    Bullish imbalance building, $740.68K bought against $57.30M of daily volume.

    Trade here 👇
    $SUI

Levels: entry runs from `price - 0.4%` up to the alert price; SL is 7% from the entry
midpoint; TPs are +4/+8/+12% from that midpoint (inverted for shorts).

> **Note:** the Python bot in `../bot/` is now OUT OF SYNC -- it still posts the older
> Telegram format. Production is this Worker.

## Setup (about 10 minutes)

You need a free Cloudflare account — no credit card required.

### 1. Log in

```bash
cd ~/Documents/omar/cloudflare
npx wrangler login
```

Opens your browser to authorise. Creates a free account if you don't have one.

### 2. Create the KV namespace (this stores the last-processed message id)

```bash
npx wrangler kv namespace create STATE
```

It prints something like:

```
[[kv_namespaces]]
binding = "STATE"
id = "a1b2c3d4e5f6..."
```

Copy that `id` into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### 3. Deploy

```bash
npx wrangler deploy
```

You'll get a URL like `https://whale-signals.YOUR-SUBDOMAIN.workers.dev`.

### 4. Add the secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN     # paste the BotFather token
npx wrangler secret put TELEGRAM_CHAT_ID       # paste: -1004290186569,709245803
```

Comma-separated chat IDs send to several places at once (channel + your DM).

### 5. Test, then let cron take over

```bash
curl "https://whale-signals.YOUR-SUBDOMAIN.workers.dev/dry"     # parses, sends nothing
curl "https://whale-signals.YOUR-SUBDOMAIN.workers.dev/run"     # sends for real
```

The Cron Trigger then fires every 2 minutes on its own. Watch it live with:

```bash
npx wrangler tail
```

### 6. Turn off the GitHub version

**Important — otherwise both post and you get every signal twice.** They keep separate
state and don't know about each other:

```bash
cd ~/Documents/omar && gh workflow disable "WhaleTracker signals"
```

## Endpoints

| Path | Does |
|---|---|
| `/health` | liveness check |
| `/state` | current `lastId`, template rotation, total sent |
| `/dry` | full parse + render, sends nothing — safe to hit anytime |
| `/run` | processes and sends now |

Set an `ADMIN_KEY` secret to require `?key=...` on `/run` if you don't want it publicly
triggerable.

## Free tier — the real numbers

| Free plan limit | Our usage |
|---|---|
| 100,000 requests/day | 720 (one per 2-min cron) — 0.7% |
| **1,000 KV writes/day** | ~500 — **the binding constraint** |
| 100,000 KV reads/day | 720 |
| 50 subrequests per invocation | ~5 (1 fetch + sends) |
| 10 ms CPU per invocation | measured **2.9 ms** on a live 105KB page |
| 1 GB KV storage | a few hundred bytes |

No expiry, no card, no trial period. It resets daily at 00:00 UTC.

**Why 2 minutes and not 1:** Cron Triggers support 1-minute granularity, but 1,440 daily
runs could exceed the 1,000 KV writes/day allowance. At 2 minutes that is impossible. The
Worker also only writes KV when something actually changed, which roughly halves it again.

**Why `maxSignalsPerRun` is 12:** each Telegram send is a subrequest, and the free plan
caps those at 50 per invocation. 12 signals x 2 chats + overhead stays well clear.

## Editing

`src/worker.js` is a single self-contained file — parsing, levels, templates, and the run
loop. Percentages live in the `CONFIG` object at the top:

```js
entryZonePct: 0.4,
stopLossPct: 5.0,
takeProfitPcts: [4.0, 8.0, 12.0],
excludeStablecoins: false,   // true skips pegged coins like USDE/RLUSD
```

Redeploy with `npx wrangler deploy` after any change.

Run `node test.mjs` to verify parsing, levels, and all seven templates still match the
Python bot exactly.
