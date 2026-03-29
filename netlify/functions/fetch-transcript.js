const https = require("https");
const http = require("http");
const { URL } = require("url");

const ALLOWED_DOMAINS = [
  "rev.com",
  "c-span.org",
  "whitehouse.gov",
  "presidency.ucsb.edu",
];

function isDomainAllowed(hostname) {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  return ALLOWED_DOMAINS.some(
    (d) => h === d || h.endsWith("." + d)
  );
}

function stripHtml(html) {
  // Remove script and style blocks entirely
  let text = html.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, " ");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "");
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function fetchUrl(urlStr) {
  return new Promise(function (resolve, reject) {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === "https:" ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; KalshiTranscriptFetcher/1.0)",
        Accept: "text/html,text/plain,*/*",
      },
    };

    const req = mod.request(options, function (res) {
      // Follow redirects (up to 3)
      if (
        [301, 302, 303, 307, 308].includes(res.statusCode) &&
        res.headers.location
      ) {
        const redirectUrl = new URL(res.headers.location, urlStr).toString();
        const redirectParsed = new URL(redirectUrl);
        if (!isDomainAllowed(redirectParsed.hostname)) {
          return reject(new Error("Redirect to disallowed domain"));
        }
        return fetchUrl(redirectUrl).then(resolve).catch(reject);
      }

      let chunks = [];
      res.on("data", function (chunk) {
        chunks.push(chunk);
      });
      res.on("end", function () {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, body: body });
      });
    });

    req.on("error", function (err) {
      reject(new Error("Fetch error: " + err.message));
    });
    req.setTimeout(15000, function () {
      req.destroy();
      reject(new Error("Request timed out"));
    });
    req.end();
  });
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors(), body: "" };
  }

  if (event.httpMethod !== "GET") {
    return respond(405, { error: "Method not allowed" });
  }

  const params = event.queryStringParameters || {};
  const url = params.url;

  if (!url) {
    return respond(400, { error: "Missing ?url= parameter" });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return respond(400, { error: "Invalid URL" });
  }

  if (!isDomainAllowed(parsed.hostname)) {
    return respond(403, {
      error: "Domain not in whitelist",
      allowed: ALLOWED_DOMAINS,
    });
  }

  try {
    const result = await fetchUrl(url);
    const text = stripHtml(result.body);
    return respond(200, { text: text, length: text.length, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return respond(502, { error: "Fetch failed", detail: e.message });
  }
};
