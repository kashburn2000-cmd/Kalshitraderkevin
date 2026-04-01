// Cloudflare Worker — Kalshi Mentions Trader
// Replaces netlify/functions/kalshi.js (signing proxy) and
// netlify/functions/state.js (Netlify Blobs persistence)

import indexHtml from '../public/index.html';

// ── Constants ───────────────────────────────────────────────────────────────

const KALSHI_BASE = 'https://api.elections.kalshi.com/trade-api/v2';

const ALLOWED_PATHS = [
  /^\/trade-api\/v2\/markets(\?.*)?$/,
  /^\/trade-api\/v2\/markets\/[^/]+$/,
  /^\/trade-api\/v2\/markets\/[^/]+\/orderbook(\?.*)?$/,
  /^\/trade-api\/v2\/markets\/[^/]+\/candlesticks(\?.*)?$/,
  /^\/trade-api\/v2\/series\/[^/]+\/markets\/[^/]+\/candlesticks(\?.*)?$/,
  /^\/trade-api\/v2\/historical\/markets(\?.*)?$/,
  /^\/trade-api\/v2\/historical\/markets\/[^/]+\/candlesticks(\?.*)?$/,
  /^\/trade-api\/v2\/historical\/cutoff(\?.*)?$/,
  /^\/trade-api\/v2\/historical\/trades(\?.*)?$/,
  /^\/trade-api\/v2\/portfolio\/balance$/,
  /^\/trade-api\/v2\/portfolio\/positions$/,
  /^\/trade-api\/v2\/portfolio\/settlements(\?.*)?$/,
  /^\/trade-api\/v2\/orders(\?.*)?$/,
  /^\/trade-api\/v2\/orders\/[^/]+\/cancel$/,
];

const ALLOWED_STATE_KEYS = [
  'kbt_positions', 'kbt_orders', 'kbt_base_rates',
  'kbt_series_filter', 'kbt_min_edge', 'kbt_max_size',
  'kbt_mode', 'kbt_bankroll', 'kbt_sizing_method',
  'kbt_known_tickers', 'kbt_alert_email',
  'kbt_backtest_results',
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

// ── RSA-PSS Signing (Web Crypto API) ────────────────────────────────────────

async function signRequest(method, path, timestampMs, privateKeyPem) {
  // Normalise PEM: handle escaped newlines from env vars
  let pem = privateKeyPem.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();

  // If PEM is on a single line, re-wrap it
  if (!pem.includes('\n')) {
    const isRSA = pem.includes('RSA PRIVATE KEY');
    const header = isRSA ? '-----BEGIN RSA PRIVATE KEY-----' : '-----BEGIN PRIVATE KEY-----';
    const footer = isRSA ? '-----END RSA PRIVATE KEY-----' : '-----END PRIVATE KEY-----';
    const body = pem.replace(header, '').replace(footer, '').trim();
    const wrapped = body.match(/.{1,64}/g).join('\n');
    pem = header + '\n' + wrapped + '\n' + footer;
  }

  // Strip PEM headers and whitespace to get raw base64
  const pemContents = pem
    .replace(/-----BEGIN.*?-----/, '')
    .replace(/-----END.*?-----/, '')
    .replace(/\s/g, '');
  const binaryDer = Uint8Array.from(atob(pemContents), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const message = timestampMs + method.toUpperCase() + path;
  const signature = await crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 },
    key,
    new TextEncoder().encode(message),
  );

  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

// ── State handler (KV — replaces Netlify Blobs) ────────────────────────────

async function handleState(request, url, env) {
  const method = request.method;
  const key = url.searchParams.get('key');

  // GET — load a value
  if (method === 'GET') {
    if (!key || !ALLOWED_STATE_KEYS.includes(key)) {
      return jsonResponse(400, { error: 'Invalid key' });
    }
    try {
      const value = await env.TRADING_STATE.get(key, { type: 'json' });
      return jsonResponse(200, { value: value ?? null });
    } catch (e) {
      return jsonResponse(200, { value: null });
    }
  }

  // POST — save a value
  if (method === 'POST') {
    let body;
    try { body = await request.json(); } catch {
      return jsonResponse(400, { error: 'Invalid JSON' });
    }
    if (!body.key || !ALLOWED_STATE_KEYS.includes(body.key)) {
      return jsonResponse(400, { error: 'Invalid key' });
    }
    try {
      await env.TRADING_STATE.put(body.key, JSON.stringify(body.value));
      return jsonResponse(200, { ok: true });
    } catch (e) {
      return jsonResponse(500, { error: e.message });
    }
  }

  // DELETE — clear a specific key or all keys
  if (method === 'DELETE') {
    try {
      if (key && ALLOWED_STATE_KEYS.includes(key)) {
        await env.TRADING_STATE.delete(key);
      } else {
        await Promise.all(ALLOWED_STATE_KEYS.map(k => env.TRADING_STATE.delete(k)));
      }
      return jsonResponse(200, { ok: true });
    } catch (e) {
      return jsonResponse(500, { error: e.message });
    }
  }

  return jsonResponse(405, { error: 'Method not allowed' });
}

// ── API proxy handler (replaces kalshi.js) ──────────────────────────────────

async function handleApi(request, url, env) {
  const method = request.method;
  const rawPath = url.pathname.replace(/^\/?api/, '');
  const qs = url.search || '';
  const kalshiPath = '/trade-api/v2' + rawPath + qs;

  // Health check
  if (rawPath === '/ping' || rawPath === '/ping/') {
    return jsonResponse(200, { ok: true, message: 'Worker is alive', ts: Date.now() });
  }

  // Whitelist check
  if (!ALLOWED_PATHS.some(re => re.test(kalshiPath))) {
    return jsonResponse(403, { error: 'Path not permitted', path: kalshiPath });
  }

  const keyId = env.KALSHI_KEY_ID;
  const privateKey = env.KALSHI_PRIVATE_KEY;

  if (!keyId || !privateKey) {
    return jsonResponse(500, {
      error: 'Credentials not configured',
      hint: 'Set KALSHI_KEY_ID and KALSHI_PRIVATE_KEY via wrangler secret put',
    });
  }

  const tsMs = Date.now().toString();
  const pathForSig = '/trade-api/v2' + rawPath;

  let sig;
  try {
    sig = await signRequest(method, pathForSig, tsMs, privateKey);
  } catch (e) {
    return jsonResponse(500, { error: 'Signing failed', detail: e.message });
  }

  const headers = {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': tsMs,
    'KALSHI-ACCESS-SIGNATURE': sig,
    'Content-Type': 'application/json',
  };

  let body = null;
  if (method === 'POST') {
    try { body = await request.text(); } catch { body = null; }
  }

  try {
    const upstream = await fetch(KALSHI_BASE + rawPath + qs, {
      method,
      headers,
      body,
    });
    const data = await upstream.text();
    let parsed;
    try { parsed = JSON.parse(data); } catch { parsed = { raw: data }; }
    return jsonResponse(upstream.status, parsed);
  } catch (e) {
    return jsonResponse(502, { error: 'Upstream failed', detail: e.message });
  }
}

// ── Main fetch handler ──────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response('', { status: 200, headers: corsHeaders() });
    }

    // State endpoints (KV)
    if (url.pathname === '/state') {
      return handleState(request, url, env);
    }

    // API proxy endpoints
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
      return handleApi(request, url, env);
    }

    // Serve index.html for root and any other path
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(indexHtml, {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // 404 for anything else
    return new Response('Not Found', { status: 404 });
  },
};
