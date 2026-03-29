const https = require("https");

const PRESIDENCY_HOST = "www.presidency.ucsb.edu";
const SEARCH_PATH = "/advanced-search?field-keywords=&field-keywords2=&field-keywords3=&from%5Bdate%5D=&to%5Bdate%5D=&person2=200301&category2%5B%5D=406&items_per_page=20";

function fetchPage(urlStr) {
  return new Promise(function (resolve, reject) {
    const parsed = new URL(urlStr);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; KalshiTrader/1.0; +https://github.com)",
      },
    };
    const req = https.request(options, function (res) {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith("http")
          ? res.headers.location
          : `https://${parsed.hostname}${res.headers.location}`;
        return fetchPage(loc).then(resolve, reject);
      }
      let data = "";
      res.on("data", function (chunk) { data += chunk; });
      res.on("end", function () { resolve(data); });
    });
    req.on("error", function (err) { reject(err); });
    req.setTimeout(15000, function () { req.destroy(); reject(new Error("Timed out")); });
    req.end();
  });
}

function extractSpeechLinks(html) {
  // Match links to individual document pages
  const links = [];
  const regex = /<a\s+href="(\/documents\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const href = match[1];
    const title = match[2].trim();
    // Skip navigation/category links, keep actual speech documents
    if (href.includes("/documents/") && title.length > 10 && !href.includes("/category/") && !href.includes("/app-categories/")) {
      links.push({ url: `https://${PRESIDENCY_HOST}${href}`, title });
    }
  }
  // Dedupe by URL
  const seen = new Set();
  return links.filter(l => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  }).slice(0, 20);
}

function extractTranscriptText(html) {
  // The transcript text is inside <div class="field-docs-content">...</div>
  const m = html.match(/<div class="field-docs-content"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
  if (!m) {
    // Fallback: try <div class="field--name-field-docs-content">
    const m2 = html.match(/<div class="field--name-field-docs-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i);
    if (!m2) return "";
    return m2[1].replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
  }
  return m[1].replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
}

function containsKeyword(text, keyword) {
  const lower = text.toLowerCase();
  const kw = keyword.toLowerCase().trim();
  // Check exact keyword
  const pattern = new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
  if (pattern.test(lower)) return true;
  // Check simple plural (add 's')
  const pluralPattern = new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "s\\b", "i");
  if (pluralPattern.test(lower)) return true;
  // Check 'es' plural
  const esPattern = new RegExp("\\b" + kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "es\\b", "i");
  if (esPattern.test(lower)) return true;
  return false;
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
  const keywordsParam = params.keywords || "";
  if (!keywordsParam) {
    return respond(400, { error: "Missing ?keywords= query parameter" });
  }

  const keywords = keywordsParam.split(",").map(k => k.trim()).filter(Boolean);
  if (keywords.length === 0) {
    return respond(400, { error: "No valid keywords provided" });
  }

  try {
    // Step 1: Fetch the search page listing Trump speeches
    const searchUrl = `https://${PRESIDENCY_HOST}${SEARCH_PATH}`;
    const listHtml = await fetchPage(searchUrl);
    const speechLinks = extractSpeechLinks(listHtml);

    if (speechLinks.length === 0) {
      return respond(200, {
        error: null,
        note: "No speeches found on listing page",
        results: {},
      });
    }

    // Step 2: Fetch each speech transcript (in parallel, batched)
    const transcripts = [];
    const BATCH = 5;
    for (let i = 0; i < speechLinks.length; i += BATCH) {
      const batch = speechLinks.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (link) => {
          const html = await fetchPage(link.url);
          const text = extractTranscriptText(html);
          return { title: link.title, text };
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value.text) {
          transcripts.push(r.value);
        }
      }
    }

    const total = transcripts.length;

    // Step 3: Count keyword frequencies
    const result = {};
    for (const kw of keywords) {
      const matching = transcripts.filter(t => containsKeyword(t.text, kw));
      result[kw] = {
        count: matching.length,
        total: total,
        rate: total > 0 ? Math.round((matching.length / total) * 100) / 100 : 0,
        speeches: matching.map(t => t.title),
      };
    }

    return respond(200, result);
  } catch (e) {
    return respond(500, { error: "Failed to fetch transcripts", detail: e.message });
  }
};
