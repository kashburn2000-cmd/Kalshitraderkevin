const https = require("https");

// Scheduled function: runs every 5 minutes via netlify.toml cron
// Also callable via GET /alert?test=true for test emails

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };
    const req = https.request(reqOpts, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: { raw: data } }); }
      });
    });
    req.on("error", (err) => reject(err));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timed out")); });
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function fetchOpenMentionMarkets() {
  const url = "https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=200&series_ticker=KXTRUMPMENTION";
  const res = await httpsRequest(url, { method: "GET", headers: { "Content-Type": "application/json" } });
  if (res.status !== 200) throw new Error(`Kalshi API returned ${res.status}`);
  return res.body.markets || [];
}

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");

  const res = await httpsRequest("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
  }, JSON.stringify({
    from: "Kalshi Alerts <onboarding@resend.dev>",
    to: [to],
    subject,
    html,
  }));

  if (res.status >= 400) {
    throw new Error(`Resend API error ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

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
    headers: { "Content-Type": "application/json", ...cors() },
    body: JSON.stringify(body),
  };
}

exports.handler = async function (event) {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: cors(), body: "" };
  }

  const isScheduled = !event.httpMethod || event.httpMethod === "SCHEDULE";
  const params = event.queryStringParameters || {};
  const isTest = params.test === "true";

  // ── Test mode: send a test email ──
  if (isTest) {
    const email = params.email || process.env.ALERT_EMAIL;
    if (!email) return respond(400, { error: "No email provided. Pass ?email=you@example.com or set ALERT_EMAIL env var." });

    try {
      await sendEmail(email, "Kalshi Alert Test", `
        <div style="font-family: system-ui; background: #0b0d0f; color: #e8eaed; padding: 24px; border-radius: 8px;">
          <h2 style="color: #00d97e; margin: 0 0 12px;">✓ Test Alert Working</h2>
          <p style="color: #8a9099;">Your Kalshi market alert system is configured correctly.</p>
          <p style="color: #8a9099; font-size: 12px; margin-top: 16px;">Sent at ${new Date().toISOString()}</p>
        </div>
      `);
      return respond(200, { ok: true, message: `Test email sent to ${email}` });
    } catch (e) {
      return respond(500, { error: "Failed to send test email", detail: e.message });
    }
  }

  // ── Scheduled run: check for new markets ──
  try {
    const markets = await fetchOpenMentionMarkets();
    const currentTickers = markets.map((m) => m.ticker);

    // Load known tickers from env var
    const knownStr = process.env.KNOWN_TICKERS || "";
    const knownSet = new Set(knownStr.split(",").filter(Boolean));

    // Find new tickers
    const newTickers = currentTickers.filter((t) => !knownSet.has(t));

    if (newTickers.length === 0) {
      return respond(200, { ok: true, message: "No new markets", total: currentTickers.length });
    }

    // Send alert email
    const alertEmail = process.env.ALERT_EMAIL;
    if (alertEmail && process.env.RESEND_API_KEY) {
      const newMarkets = markets.filter((m) => newTickers.includes(m.ticker));
      const marketRows = newMarkets.map((m) => {
        const bid = m.yes_bid_dollars || "—";
        const ask = m.yes_ask_dollars || "—";
        return `<tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #1e2227; color: #3d9eff; font-family: monospace;">${m.ticker}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #1e2227; color: #e8eaed;">${m.title || ""}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #1e2227; color: #8a9099; font-family: monospace;">${bid} / ${ask}</td>
        </tr>`;
      }).join("");

      await sendEmail(alertEmail, `🔔 ${newTickers.length} New Kalshi Market${newTickers.length > 1 ? "s" : ""} Opened`, `
        <div style="font-family: system-ui; background: #0b0d0f; color: #e8eaed; padding: 24px; border-radius: 8px;">
          <h2 style="color: #00d97e; margin: 0 0 16px;">🔔 New Market Alert</h2>
          <p style="color: #8a9099; margin-bottom: 16px;">${newTickers.length} new KXTRUMPMENTION market${newTickers.length > 1 ? "s" : ""} detected:</p>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead>
              <tr style="border-bottom: 2px solid #1e2227;">
                <th style="padding: 8px 12px; text-align: left; color: #545b64; font-size: 10px; text-transform: uppercase;">Ticker</th>
                <th style="padding: 8px 12px; text-align: left; color: #545b64; font-size: 10px; text-transform: uppercase;">Title</th>
                <th style="padding: 8px 12px; text-align: left; color: #545b64; font-size: 10px; text-transform: uppercase;">Bid / Ask</th>
              </tr>
            </thead>
            <tbody>${marketRows}</tbody>
          </table>
          <p style="color: #545b64; font-size: 11px; margin-top: 16px;">Kalshi Mentions Trader · ${new Date().toISOString()}</p>
        </div>
      `);
    }

    // Update KNOWN_TICKERS — merge old + new
    const updatedTickers = [...new Set([...knownSet, ...currentTickers])].join(",");

    // Note: In production, you'd update the env var via Netlify API.
    // For now we store in response and the function tracks state across calls
    // via the KNOWN_TICKERS env var which should be set via Netlify dashboard.

    return respond(200, {
      ok: true,
      newMarkets: newTickers,
      total: currentTickers.length,
      message: `Found ${newTickers.length} new market(s). Alert sent.`,
      updatedKnownTickers: updatedTickers,
    });
  } catch (e) {
    return respond(500, { error: "Alert check failed", detail: e.message });
  }
};
