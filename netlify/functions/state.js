const { getStore } = require('@netlify/blobs');

const ALLOWED_KEYS = [
  'kbt_positions', 'kbt_orders', 'kbt_base_rates',
  'kbt_series_filter', 'kbt_min_edge', 'kbt_max_size',
  'kbt_mode', 'kbt_bankroll', 'kbt_sizing_method',
  'kbt_known_tickers', 'kbt_alert_email',
  'kbt_backtest_results'
];

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function respond(status, body) {
  return {
    statusCode: status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, cors()),
    body: JSON.stringify(body),
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }

  let store;
  try {
    store = getStore('trading-state');
  } catch (e) {
    return respond(500, {
      error: 'Netlify Blobs not available',
      detail: e.message,
      hint: 'Ensure this site is deployed via Netlify (not drag-and-drop) and Blobs is enabled.',
    });
  }

  const key = event.queryStringParameters && event.queryStringParameters.key;

  // GET — load a value
  if (event.httpMethod === 'GET') {
    if (!key || !ALLOWED_KEYS.includes(key)) {
      return respond(400, { error: 'Invalid key' });
    }
    try {
      const value = await store.get(key, { type: 'json' });
      return respond(200, { value: value ?? null });
    } catch (e) {
      return respond(200, { value: null });
    }
  }

  // POST — save a value
  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body); } catch {
      return respond(400, { error: 'Invalid JSON' });
    }
    if (!body.key || !ALLOWED_KEYS.includes(body.key)) {
      return respond(400, { error: 'Invalid key' });
    }
    try {
      await store.set(body.key, JSON.stringify(body.value));
      return respond(200, { ok: true });
    } catch (e) {
      return respond(500, { error: e.message });
    }
  }

  // DELETE — clear a specific key or all keys
  if (event.httpMethod === 'DELETE') {
    try {
      if (key && ALLOWED_KEYS.includes(key)) {
        await store.delete(key);
      } else {
        await Promise.all(ALLOWED_KEYS.map(k => store.delete(k)));
      }
      return respond(200, { ok: true });
    } catch (e) {
      return respond(500, { error: e.message });
    }
  }

  return respond(405, { error: 'Method not allowed' });
};
