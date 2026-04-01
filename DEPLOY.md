# Kalshi Mentions Trader — Cloudflare Workers Deployment Guide

## Folder structure
```
kalshi-trader/
├── wrangler.toml              ← Cloudflare Workers config
├── workers/
│   └── index.js               ← Worker: signing proxy + KV state + static serving
├── public/
│   └── index.html             ← the dashboard
└── package.json
```

---

## Step 1 — Get your Kalshi API key

1. Go to https://kalshi.com/account/profile
2. Scroll to **API Keys** → click **Create New API Key**
3. Copy your **Key ID** (looks like: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
4. Download the **private key** `.pem` file — open it in Notepad, copy ALL the text including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines

---

## Step 2 — Install Wrangler CLI

```bash
npm install -g wrangler
```

---

## Step 3 — Login to Cloudflare

```bash
wrangler login
```

---

## Step 4 — Create a KV namespace

```bash
wrangler kv:namespace create "TRADING_STATE"
```

Copy the `id` value from the output and paste it into `wrangler.toml` replacing `REPLACE_WITH_KV_NAMESPACE_ID`.

---

## Step 5 — Set secrets

```bash
wrangler secret put KALSHI_KEY_ID
# Paste your Key ID when prompted

wrangler secret put KALSHI_PRIVATE_KEY
# Paste the entire PEM text (including BEGIN/END lines) when prompted
```

---

## Step 6 — Deploy

```bash
wrangler deploy
```

Your Worker will be live at `https://kalshi-trader.<your-subdomain>.workers.dev`.

---

## Local development

```bash
npm install
npm run dev
```

This starts a local dev server with `wrangler dev`.

---

## Verify it works

1. Visit your Worker URL
2. The topbar should show a green **"✓ API connected"** badge with your balance
3. If it shows amber "⚠ credentials not configured" — the secrets didn't save, repeat Step 5
4. If it shows an HTTP error — double-check the Key ID and that the full PEM was pasted

---

## Security notes

- Your private key lives ONLY in Cloudflare Workers encrypted secrets — never in the HTML
- The proxy function validates every request path against a whitelist before forwarding
- The browser never sees your key at any point
- If you ever suspect your key is compromised: delete it on Kalshi's site immediately and generate a new one

---

## Switching from Paper to Live trading

The dashboard defaults to **Paper** mode (simulated, no real orders).
To place real orders:
1. Click **LIVE** in the top toggle
2. A warning will appear — confirm you understand real money is at stake
3. The "Paper Trade" buttons become "Trade" and submit real limit orders to Kalshi

Start with small position sizes. The backtester must show positive edge before going live.
