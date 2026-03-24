// netlify/functions/kalshi.js
// Secure proxy: signs Kalshi API requests server-side so the private key
// never leaves this function and is never exposed to the browser.
//
// Environment variables to set in Netlify dashboard:
//   KALSHI_KEY_ID      — your Key ID from kalshi.com/account/profile
//   KALSHI_PRIVATE_KEY — your full PEM private key (include header/footer lines)

const https = require("https");
const http = require("http");
const crypto = require("crypto");

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// ── RSA-PSS signing (matches Kalshi's auth spec exactly) ─────────────────────
function signRequest(method, path, timestampMs, privateKeyPem) {
  const message = `${timestampMs}${method.toUpperCase()}${path}`;

  // Normalize key — Netlify can collapse newlines, and Kalshi generates
  // PKCS#1 (RSA PRIVATE KEY) format. Handle both gracefully.
  let pem = privateKeyPem
    .replace(/\n/g, "
")   // escaped literal 
 -> real newline
    .replace(/
/g, "
")  // windows line endings
    .trim();

  // If newlines are missing, reformat into proper PEM 64-char lines
  if (!pem.includes("
")) {
    const isRSA = pem.includes("RSA PRIVATE KEY");
    const header = isRSA ? "-----BEGIN RSA PRIVATE KEY-----" : "-----BEGIN PRIVATE KEY-----";
    const footer = isRSA ? "-----END RSA PRIVATE KEY-----" : "-----END PRIVATE KEY-----";
    const body = pem.replace(header, "").replace(footer, "").trim().match(/.{1,64}/g).join("
");
    pem = header + "
" + body + "
" + footer;
  }

  const signature = crypto.sign(
    "sha256",
    Buffer.from(message, "utf8"),
    {
      key: pem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }
  );
  return signature.toString("base64");
}

// ── HTTPS request helper (uses Node built-in, works in Netlify functions) ────
function httpsRequest(urlStr, options, body) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: { raw: data } });
        }
      });
    });

    req.on("error", (err) => {
      reject(new Error(`Network error: ${err.message} (code: ${err.code})`));
    });

    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error("Request timed out after 10s"));
    });

    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

// ── Allowed endpoints whitelist (security: only permit what the app needs) ────
const ALLOWED_PATHS = [
  /^\/trade-api\/v2\/markets(\?.*)?$/,
  /^\/trade-api\/v2\/markets\/[^/]+$/,
  /^\/trade-api\/v2\/markets\/[^/]+\/orderbook$/,
  /^\/trade-api\/v2\/markets\/[^/]+\/candlesticks(\?.*)?$/,
  /^\/trade-api\/v2\/historical\/markets(\?.*)?$/,
  /^\/trade-api\/v2\/historical\/markets\/[^/]+$/,
  /^\/trade-api\/v2\/historical\/cutoff$/,
  /^\/trade-api\/v2\/portfolio\/balance$/,
  /^\/trade-api\/v2\/portfolio\/positions$/,
  /^\/trade-api\/v2\/portfolio\/settlements(\?.*)?$/,
  /^\/trade-api\/v2\/orders(\?.*)?$/,
  /^\/trade-api\/v2\/orders$/,                    // POST new order
  /^\/trade-api\/v2\/orders\/[^/]+\/cancel$/,     // POST cancel
];

function isAllowed(path) {
  return ALLOWED_PATHS.some(re => re.test(path));
}

// ── Main handler ──────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: "",
    };
  }

  // Extract the Kalshi API path from the URL
  // Netlify routes /api/* → this function with path = /api/markets?...
  // We strip /api prefix and prepend /trade-api/v2
  const rawPath = event.path.replace(/^\/?api/, "");
  const queryString = event.rawQuery ? `?${event.rawQuery}` : "";
  const kalshiPath = `/trade-api/v2${rawPath}${queryString}`;

  // Built-in ping — lets us verify the function is running at all
  if (rawPath === "/ping" || rawPath === "/ping/") {
    return respond(200, { ok: true, message: "Function is alive", ts: Date.now() });
  }

  // Security: validate path is on whitelist
  if (!isAllowed(kalshiPath)) {
    return respond(403, { error: "Path not permitted", path: kalshiPath });
  }

  // Check credentials are configured
  const keyId = process.env.KALSHI_KEY_ID;
  const privateKeyPem = process.env.KALSHI_PRIVATE_KEY;

  if (!keyId || !privateKeyPem) {
    return respond(500, {
      error: "Kalshi credentials not configured",
      hint: "Set KALSHI_KEY_ID and KALSHI_PRIVATE_KEY in Netlify environment variables",
    });
  }

  // Build signed headers
  const method = event.httpMethod;
  const timestampMs = Date.now().toString();
  let signature;
  try {
    signature = signRequest(method, kalshiPath.split("?")[0], timestampMs, privateKeyPem);
  } catch (e) {
    return respond(500, { error: "Failed to sign request", detail: e.message });
  }

  const headers = {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": timestampMs,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "Content-Type": "application/json",
  };

  // Forward request to Kalshi
  const url = new URL(KALSHI_BASE + rawPath + queryString);
  const options = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method,
    headers,
  };

  let body;
  if (event.body) {
    try { body = JSON.parse(event.body); } catch { body = event.body; }
  }

  try {
    const result = await httpsRequest(url.toString(), options, body);
    return respond(result.status, result.body);
  } catch (e) {
    return respond(502, {
      error: "Upstream request failed",
      detail: e.message,
      target: url.toString(),
      hint: "Check Netlify function logs for full error. May be a network restriction on free tier."
    });
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
    body: JSON.stringify(body),
  };
}
