# Kalshi Mentions Trader — Netlify Deployment Guide

## Folder structure to upload
```
kalshi-netlify/
├── netlify.toml                  ← routing config
├── netlify/
│   └── functions/
│       └── kalshi.js             ← secure signing proxy
└── public/
    └── index.html                ← the dashboard
```

---

## Step 1 — Get your Kalshi API key

1. Go to https://kalshi.com/account/profile
2. Scroll to **API Keys** → click **Create New API Key**
3. Copy your **Key ID** (looks like: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
4. Download the **private key** `.pem` file — open it in Notepad, copy ALL the text including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines

---

## Step 2 — Deploy to Netlify

### Option A: Netlify CLI (easiest)
```bash
npm install -g netlify-cli
cd kalshi-netlify
netlify deploy --prod
```

### Option B: GitHub (recommended for updates)
1. Push this folder to a GitHub repo
2. Go to app.netlify.com → New site from Git → connect your repo
3. Build settings: leave blank (no build command needed)
4. Publish directory: `public`
5. Deploy

### Option C: Drag and drop
Zip the entire `kalshi-netlify` folder and drag to app.netlify.com/drop
(Note: functions may not work with drag-and-drop on free tier — use Option A or B)

---

## Step 3 — Add environment variables (THE IMPORTANT PART)

1. Go to your site in the Netlify dashboard
2. **Site configuration** → **Environment variables** → **Add a variable**

Add these two:

| Key | Value |
|-----|-------|
| `KALSHI_KEY_ID` | Your Key ID from Step 1 |
| `KALSHI_PRIVATE_KEY` | The entire PEM text including BEGIN/END lines |

For the private key, paste the whole thing — newlines included. It should look like:
```
-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC...
(many lines)
-----END PRIVATE KEY-----
```

3. Click **Save** after adding each variable
4. **Trigger a redeploy**: Deploys → Trigger deploy → Deploy site

---

## Step 4 — Verify it works

1. Visit your Netlify URL
2. The topbar should show a green **"✓ API connected"** badge with your balance
3. If it shows amber "⚠ credentials not configured" — the env vars didn't save, repeat Step 3
4. If it shows an HTTP error — double-check the Key ID and that the full PEM was pasted

---

## Security notes

- Your private key lives ONLY in Netlify's encrypted environment variables — never in the HTML
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
