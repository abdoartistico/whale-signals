# Cloudflare Workers version

Same bot, same seven templates, same levels — but on Cloudflare's scheduler instead of
GitHub's. Runs **every 2 minutes**, reliably, instead of GitHub's "whenever the queue feels
like it".

Why this exists: GitHub assigns scheduled workflows to priority queues based on account age
and repo history. A new account/repo lands in a heavily throttled queue where runs are
delayed by hours or dropped outright, and changing the cron expression does not help.
Cloudflare Cron Triggers fire on time.

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
