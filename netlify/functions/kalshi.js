const https = require("https");
const crypto = require("crypto");

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

function signRequest(method, path, timestampMs, privateKeyPem) {
  const message = timestampMs + method.toUpperCase() + path;

  let pem = privateKeyPem.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();

  if (!pem.includes("\n")) {
    const isRSA = pem.includes("RSA PRIVATE KEY");
    const header = isRSA ? "-----BEGIN RSA PRIVATE KEY-----" : "-----BEGIN PRIVATE KEY-----";
    const footer = isRSA ? "-----END RSA PRIVATE KEY-----" : "-----END PRIVATE KEY-----";
    const body = pem.replace(header, "").replace(footer, "").trim();
    const wrapped = body.match(/.{1,64}/g).join("\n");
    pem = header + "\n" + wrapped + "\n" + footer;
  }

  const sig = crypto.sign("sha256", Buffer.from(message, "utf8"), {
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sig.toString("base64");
}

function proxyRequest(urlStr, method, headers, body) {
  return new Promise(function(resolve, reject) {
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: method,
      headers: headers,
    };

    const req = https.request(options, function(res) {
      let data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    });

    req.on("error", function(err) { reject(new Error("Network error: " + err.message)); });
    req.setTimeout(15000, function() { req.destroy(); reject(new Error("Timed out")); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const ALLOWED = [
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

function isAllowed(p) { return ALLOWED.some(function(re) { return re.test(p); }); }

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function respond(status, body) {
  return {
    statusCode: status,
    headers: Object.assign({ "Content-Type": "application/json" }, cors()),
    body: JSON.stringify(body),
  };
}

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors(), body: "" };
  }

  const rawPath = event.path.replace(/^\/?api/, "");
  const qs = event.rawQuery ? "?" + event.rawQuery : "";
  const kalshiPath = "/trade-api/v2" + rawPath + qs;

  if (rawPath === "/ping" || rawPath === "/ping/") {
    return respond(200, { ok: true, message: "Function is alive", ts: Date.now() });
  }

  if (!isAllowed(kalshiPath)) {
    return respond(403, { error: "Path not permitted", path: kalshiPath });
  }

  const keyId = process.env.KALSHI_KEY_ID;
  const privateKey = process.env.KALSHI_PRIVATE_KEY;

  if (!keyId || !privateKey) {
    return respond(500, {
      error: "Credentials not configured",
      hint: "Set KALSHI_KEY_ID and KALSHI_PRIVATE_KEY in Netlify environment variables",
    });
  }

  const method = event.httpMethod;
  const tsMs = Date.now().toString();
  const pathForSig = "/trade-api/v2" + rawPath;

  let sig;
  try { sig = signRequest(method, pathForSig, tsMs, privateKey); }
  catch (e) { return respond(500, { error: "Signing failed", detail: e.message }); }

  const headers = {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": tsMs,
    "KALSHI-ACCESS-SIGNATURE": sig,
    "Content-Type": "application/json",
  };

  let body;
  if (event.body) {
    try { body = JSON.parse(event.body); } catch (e) { body = null; }
  }

  try {
    const result = await proxyRequest(KALSHI_BASE + rawPath + qs, method, headers, body);
    return respond(result.status, result.body);
  } catch (e) {
    return respond(502, { error: "Upstream failed", detail: e.message });
  }
};
