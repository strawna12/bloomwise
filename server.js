// BloomWise — Full Stack Server v2
// PostgreSQL + Stripe + Claude AI + Garden Planner
//
// Required environment variables:
//   ANTHROPIC_API_KEY   — Claude API key
//   DATABASE_URL        — PostgreSQL connection string (Railway provides this)
//   STRIPE_SECRET_KEY   — Stripe secret key (sk_live_... or sk_test_...)
//   STRIPE_WEBHOOK_SECRET — Stripe webhook signing secret
//   STRIPE_PRICE_ID     — Stripe Price ID for the Pro monthly plan
//   PERENUAL_API_KEY    — (optional) Perenual plant photo API key
//
// Local dev:
//   DATABASE_URL=postgres://... ANTHROPIC_API_KEY=sk-ant-... node server.js
//   Then open http://localhost:3000

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

// PostgreSQL
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

// Stripe
const Stripe = require("stripe");
const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const PORT             = process.env.PORT || 3000;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const MODEL            = process.env.MODEL || "claude-haiku-4-5-20251001";
const STRIPE_PRICE_ID  = process.env.STRIPE_PRICE_ID || "";
const STRIPE_WEBHOOK   = process.env.STRIPE_WEBHOOK_SECRET || "";
const PERENUAL_KEY     = process.env.PERENUAL_API_KEY || "";

const FREE_DAILY_LIMIT = 3;
const PRO_PRICE        = "$4.99/month";

// ---------- Database setup ----------

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          TEXT PRIMARY KEY,
        email       TEXT,
        is_pro      BOOLEAN DEFAULT FALSE,
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS usage (
        user_id     TEXT NOT NULL,
        date        DATE NOT NULL DEFAULT CURRENT_DATE,
        count       INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, date)
      );

      CREATE TABLE IF NOT EXISTS gardens (
        user_id     TEXT PRIMARY KEY,
        plants      JSONB DEFAULT '[]',
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("[DB] Tables ready");
  } catch (e) {
    console.error("[DB] Init error:", e.message);
  }
}

// ---------- Rate limiter (IP-based, in-memory) ----------

const WINDOW_MS    = 60 * 1000;
const MAX_REQUESTS = 30;
const rateCounts   = new Map();

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = rateCounts.get(ip) || { count: 0, start: now };
  if (now - entry.start > WINDOW_MS) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateCounts.set(ip, entry);
  return entry.count > MAX_REQUESTS;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateCounts)
    if (now - entry.start > WINDOW_MS * 2) rateCounts.delete(ip);
}, 5 * 60 * 1000);

// ---------- Helpers ----------

function getIP(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0].trim();
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type":  "application/json",
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type, X-User-ID",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
  });
  res.end(body);
}

function sendHTML(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 50000) reject(new Error("Request too large"));
    });
    req.on("end", () => {
      try   { resolve(JSON.parse(body)); }
      catch { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function callAnthropic(prompt, maxTokens = 1800) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      MODEL,
      max_tokens: maxTokens,
      messages:   [{ role: "user", content: prompt }],
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path:     "/v1/messages",
      method:   "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length":    Buffer.byteLength(body),
      },
    }, (apiRes) => {
      let data = "";
      apiRes.on("data", chunk => data += chunk);
      apiRes.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) return reject(new Error(parsed.error.message));
          resolve((parsed.content || []).map(b => b.text || "").join(""));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function parseJSON(text, type = "array") {
  const clean = text.replace(/```json|```/gi, "").trim();
  const s = clean.indexOf(type === "array" ? "[" : "{");
  const e = type === "array" ? clean.lastIndexOf("]") : clean.lastIndexOf("}");
  if (s > -1 && e > -1) return JSON.parse(clean.slice(s, e + 1));
  throw new Error("Could not parse JSON from AI response");
}

// ---------- User & usage helpers ----------

async function getOrCreateUser(userId) {
  if (!userId) return null;
  try {
    const r = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);
    if (r.rows.length) return r.rows[0];
    await pool.query("INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING", [userId]);
    return { id: userId, is_pro: false };
  } catch (e) {
    console.error("[DB] getOrCreateUser:", e.message);
    return null;
  }
}

async function checkAndIncrementUsage(userId) {
  // Returns { allowed: bool, used: number, limit: number, isPro: bool }
  try {
    const user = await getOrCreateUser(userId);
    const isPro = user?.is_pro || false;
    if (isPro) return { allowed: true, used: 0, limit: Infinity, isPro: true };

    const today = new Date().toISOString().slice(0, 10);
    const r = await pool.query(
      `INSERT INTO usage (user_id, date, count) VALUES ($1, $2, 1)
       ON CONFLICT (user_id, date) DO UPDATE SET count = usage.count + 1
       RETURNING count`,
      [userId, today]
    );
    const used = r.rows[0].count;
    return { allowed: used <= FREE_DAILY_LIMIT, used, limit: FREE_DAILY_LIMIT, isPro: false };
  } catch (e) {
    console.error("[DB] checkUsage:", e.message);
    return { allowed: true, used: 0, limit: FREE_DAILY_LIMIT, isPro: false }; // fail open
  }
}

async function getUsageStatus(userId) {
  try {
    const user = await getOrCreateUser(userId);
    const isPro = user?.is_pro || false;
    if (isPro) return { used: 0, limit: Infinity, isPro: true, remaining: Infinity };

    const today = new Date().toISOString().slice(0, 10);
    const r = await pool.query(
      "SELECT count FROM usage WHERE user_id=$1 AND date=$2",
      [userId, today]
    );
    const used = r.rows[0]?.count || 0;
    return { used, limit: FREE_DAILY_LIMIT, isPro: false, remaining: Math.max(0, FREE_DAILY_LIMIT - used) };
  } catch (e) {
    return { used: 0, limit: FREE_DAILY_LIMIT, isPro: false, remaining: FREE_DAILY_LIMIT };
  }
}

// ---------- Photo fetching ----------

async function fetchPerenualPhoto(query) {
  if (!PERENUAL_KEY) return null;
  return new Promise((resolve) => {
    const path = `/api/species-list?key=${PERENUAL_KEY}&q=${encodeURIComponent(query)}&page=1`;
    const req = https.request({ hostname: "perenual.com", path, method: "GET" }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const d = JSON.parse(data);
          const img = d.data?.[0]?.default_image?.medium_url || d.data?.[0]?.default_image?.regular_url;
          resolve(img || null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function fetchWikiPhoto(query) {
  return new Promise((resolve) => {
    const path = `/w/api.php?action=query&titles=${encodeURIComponent(query)}&prop=pageimages&format=json&pithumbsize=600`;
    const req = https.request({ hostname: "en.wikipedia.org", path, method: "GET",
      headers: { "User-Agent": "BloomWise/2.0 (plant advisor app)" }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const d = JSON.parse(data);
          const pages = d.query?.pages;
          if (!pages) return resolve(null);
          resolve(Object.values(pages)[0]?.thumbnail?.source || null);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

async function getPhotos(commonName, scientificName) {
  const photos = [];
  const genus  = (scientificName || "").split(" ")[0];

  // Try Perenual first (higher quality botanical photos)
  if (PERENUAL_KEY) {
    const p1 = await fetchPerenualPhoto(scientificName);
    if (p1) photos.push(p1);
    if (photos.length < 2) {
      const p2 = await fetchPerenualPhoto(commonName);
      if (p2 && !photos.includes(p2)) photos.push(p2);
    }
  }

  // Fill remaining slots from Wikipedia
  const tried = new Set();
  for (const q of [scientificName, genus, commonName]) {
    if (photos.length >= 2) break;
    if (!q || tried.has(q)) continue;
    tried.add(q);
    const url = await fetchWikiPhoto(q);
    if (url && !photos.includes(url)) photos.push(url);
  }

  return photos;
}

// ---------- Zone detection ----------

async function detectZone(location) {
  if (!location) return null;
  // Try a simple geocode via nominatim → then map to USDA zone via lat
  return new Promise((resolve) => {
    const path = `/search?q=${encodeURIComponent(location)}&format=json&limit=1&addressdetails=1`;
    const req = https.request({
      hostname: "nominatim.openstreetmap.org",
      path,
      method: "GET",
      headers: { "User-Agent": "BloomWise/2.0" },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const d = JSON.parse(data);
          if (!d.length) return resolve(null);
          const lat = parseFloat(d[0].lat);
          // Rough USDA zone from latitude (continental US)
          let zone;
          if (lat >= 49)       zone = "Zone 3–4";
          else if (lat >= 47)  zone = "Zone 4–5";
          else if (lat >= 45)  zone = "Zone 5";
          else if (lat >= 43)  zone = "Zone 5–6";
          else if (lat >= 41)  zone = "Zone 6";
          else if (lat >= 39)  zone = "Zone 6–7";
          else if (lat >= 37)  zone = "Zone 7";
          else if (lat >= 35)  zone = "Zone 7–8";
          else if (lat >= 33)  zone = "Zone 8";
          else if (lat >= 31)  zone = "Zone 8–9";
          else if (lat >= 29)  zone = "Zone 9";
          else if (lat >= 27)  zone = "Zone 9–10";
          else                 zone = "Zone 10–11";
          resolve(zone);
        } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// ---------- API route handlers ----------

async function handleRecommendations(req, res) {
  const userId = req.headers["x-user-id"] || null;
  const p = await readBody(req);

  // Check usage limit
  const usage = await checkAndIncrementUsage(userId);
  if (!usage.allowed) {
    return sendJSON(res, 429, {
      error: "daily_limit_reached",
      message: `You've used all ${FREE_DAILY_LIMIT} free recommendations today. Upgrade to Pro for unlimited access.`,
      used: usage.used,
      limit: usage.limit,
    });
  }

  const prompt = `You are a professional horticulturist and landscape designer. Recommend exactly 6 plants perfectly suited to this client. Return ONLY a valid JSON array, nothing else.

Client profile:
Location: ${p.location || "Not specified"} | USDA Zone: ${p.zone || "unknown"} | Current season: ${p.season || "not specified"} | Climate: ${p.climate || "not specified"}
Sun: ${p.sun || "not specified"} | Soil: ${p.soil || "not specified"} | pH: ${p.ph || "unknown"} | Drainage: ${p.drainage || "unknown"}
Microclimate: ${p.microclimate || "none"} | Water: ${p.water || "not specified"} | Water restrictions: ${p.wrestrict || "none"}
Rainfall: ${p.rainfall || "unknown"} | Irrigation: ${p.irrigation || "none"} | Style: ${p.style || "not specified"}
Colors: ${p.colors || "no preference"} | Priorities: ${p.priorities || "none"} | Notes: ${p.notes || "none"}

[{"name":"Common Name","scientific":"Genus species","sun":"short","water":"short","soil":"short","fit":"why it matches (5-8 words)","planting_season":"e.g. Fall (Sep-Nov)","description":"3 sentences: why it thrives here, standout qualities, one care tip"}]`;

  const text   = await callAnthropic(prompt, 1800);
  const plants = parseJSON(text, "array");
  sendJSON(res, 200, { plants, usage: { used: usage.used, limit: usage.limit, isPro: usage.isPro } });
}

async function handleLookup(req, res) {
  const userId = req.headers["x-user-id"] || null;
  const { plant, site } = await readBody(req);

  // Lookup counts against daily limit too
  const usage = await checkAndIncrementUsage(userId);
  if (!usage.allowed) {
    return sendJSON(res, 429, {
      error: "daily_limit_reached",
      message: `You've used all ${FREE_DAILY_LIMIT} free lookups today. Upgrade to Pro for unlimited access.`,
      used: usage.used,
      limit: usage.limit,
    });
  }

  const siteInfo = site
    ? `User site — Location: ${site.location}, Zone: ${site.zone}, Season: ${site.season}, Sun: ${site.sun}, Soil: ${site.soil}, pH: ${site.ph}, Drainage: ${site.drainage}, Water: ${site.water}, Restrictions: ${site.wrestrict}, Style: ${site.style}, Priorities: ${site.priorities}`
    : "No site profile — give general info, use neutral status for all requirements.";

  const prompt = `You are an expert horticulturist. Evaluate "${plant}" as a garden plant.
${siteInfo}
Return ONLY a valid JSON object:
{"name":"common name","scientific":"Genus species","verdict":"green","verdict_label":"Great choice","summary":"2-3 sentence assessment","planting_season":"best season with months","requirements":[{"label":"Sun","value":"needs","status":"ok","note":"note"},{"label":"Water","value":"needs","status":"ok","note":"note"},{"label":"Soil","value":"needs","status":"ok","note":"note"},{"label":"Hardiness zone","value":"zones","status":"ok","note":"note"},{"label":"Maintenance","value":"low/moderate/high","status":"neutral","note":"details"},{"label":"Mature size","value":"h x w","status":"neutral","note":"note"}],"special_requirements":["req1","req2","req3"],"pro_tip":"one practical tip"}
verdict: green/yellow/red. status: ok/warn/bad/neutral.`;

  const text   = await callAnthropic(prompt, 1100);
  const result = parseJSON(text, "object");
  sendJSON(res, 200, { result, usage: { used: usage.used, limit: usage.limit, isPro: usage.isPro } });
}

async function handleClaude(req, res) {
  const { prompt, max } = await readBody(req);
  if (!prompt) return sendJSON(res, 400, { error: "prompt is required" });
  const text = await callAnthropic(prompt, max || 1800);
  sendJSON(res, 200, { text });
}

async function handlePhotos(req, res) {
  const { common, scientific } = await readBody(req);
  const photos = await getPhotos(common || "", scientific || "");
  sendJSON(res, 200, { photos });
}

async function handleZone(req, res) {
  const { location } = await readBody(req);
  const zone = await detectZone(location);
  sendJSON(res, 200, { zone });
}

// ---------- User / usage status ----------

async function handleUserStatus(req, res) {
  const userId = req.headers["x-user-id"] || null;
  if (!userId) return sendJSON(res, 400, { error: "x-user-id header required" });
  const status = await getUsageStatus(userId);
  sendJSON(res, 200, status);
}

// ---------- Garden persistence (PostgreSQL) ----------

async function handleGardenGet(req, res) {
  const userId = req.headers["x-user-id"] || null;
  if (!userId) return sendJSON(res, 400, { error: "x-user-id header required" });
  try {
    await getOrCreateUser(userId);
    const r = await pool.query("SELECT plants FROM gardens WHERE user_id=$1", [userId]);
    sendJSON(res, 200, { plants: r.rows[0]?.plants || [] });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

async function handleGardenSave(req, res) {
  const userId = req.headers["x-user-id"] || null;
  if (!userId) return sendJSON(res, 400, { error: "x-user-id header required" });
  const { plants } = await readBody(req);
  try {
    await getOrCreateUser(userId);
    await pool.query(
      `INSERT INTO gardens (user_id, plants, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET plants=$2, updated_at=NOW()`,
      [userId, JSON.stringify(plants || [])]
    );
    sendJSON(res, 200, { ok: true });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

// ---------- Stripe ----------

async function handleCreateCheckout(req, res) {
  if (!stripe) return sendJSON(res, 500, { error: "Stripe not configured" });
  const userId = req.headers["x-user-id"] || null;
  const { email, successUrl, cancelUrl } = await readBody(req);

  try {
    // Get or create Stripe customer
    let customerId;
    if (userId) {
      const r = await pool.query("SELECT stripe_customer_id FROM users WHERE id=$1", [userId]);
      customerId = r.rows[0]?.stripe_customer_id;
    }
    if (!customerId) {
      const customer = await stripe.customers.create({ email: email || undefined,
        metadata: { bloomwise_user_id: userId || "anonymous" } });
      customerId = customer.id;
      if (userId) {
        await pool.query("UPDATE users SET stripe_customer_id=$1 WHERE id=$2", [customerId, userId]);
      }
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      mode: "subscription",
      success_url: successUrl || `${req.headers.origin || ""}/?pro=success`,
      cancel_url:  cancelUrl  || `${req.headers.origin || ""}/?pro=cancel`,
      metadata: { bloomwise_user_id: userId || "anonymous" },
    });

    sendJSON(res, 200, { url: session.url });
  } catch (e) {
    sendJSON(res, 500, { error: e.message });
  }
}

async function handleStripeWebhook(req, res) {
  if (!stripe) return sendJSON(res, 500, { error: "Stripe not configured" });
  const rawBody = await readRawBody(req);
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK);
  } catch (e) {
    console.error("[Stripe] Webhook signature failed:", e.message);
    return sendJSON(res, 400, { error: "Webhook signature verification failed" });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId  = session.metadata?.bloomwise_user_id;
      const subId   = session.subscription;
      if (userId && userId !== "anonymous") {
        await pool.query(
          "UPDATE users SET is_pro=TRUE, stripe_subscription_id=$1 WHERE id=$2",
          [subId, userId]
        );
        console.log(`[Stripe] Pro activated for user ${userId}`);
      }
    }

    if (event.type === "customer.subscription.deleted" ||
        event.type === "customer.subscription.paused") {
      const sub    = event.data.object;
      const custId = sub.customer;
      await pool.query(
        "UPDATE users SET is_pro=FALSE, stripe_subscription_id=NULL WHERE stripe_customer_id=$1",
        [custId]
      );
      console.log(`[Stripe] Pro revoked for customer ${custId}`);
    }

    if (event.type === "invoice.payment_failed") {
      // Optionally handle failed payments — for now just log
      console.warn("[Stripe] Payment failed:", event.data.object.customer);
    }
  } catch (e) {
    console.error("[Stripe] Webhook handler error:", e.message);
  }

  sendJSON(res, 200, { received: true });
}

// ---------- Main server ----------

const FRONTEND_PATH = path.join(__dirname, "index.html");

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Headers": "Content-Type, X-User-ID",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
    });
    return res.end();
  }

  // ── Frontend (GET) ─────────────────────────────────────
  if (req.method === "GET") {
    if (url === "/" || url === "/index.html") return sendHTML(res, FRONTEND_PATH);
    if (url === "/health") return sendJSON(res, 200, { status: "ok", model: MODEL, db: !!pool });
    return sendHTML(res, FRONTEND_PATH);
  }

  // ── API (POST) ─────────────────────────────────────────
  if (req.method === "POST") {
    // Stripe webhook — must be processed before JSON body parsing
    if (url === "/stripe/webhook") {
      try { await handleStripeWebhook(req, res); }
      catch (e) { sendJSON(res, 500, { error: e.message }); }
      return;
    }

    if (!ANTHROPIC_KEY && ["/recommendations", "/lookup", "/claude"].includes(url)) {
      return sendJSON(res, 500, { error: "ANTHROPIC_API_KEY not set — add it in Railway environment variables" });
    }

    const ip = getIP(req);
    if (isRateLimited(ip)) {
      return sendJSON(res, 429, { error: "Too many requests — please wait a moment and try again" });
    }

    try {
      if      (url === "/recommendations")    await handleRecommendations(req, res);
      else if (url === "/lookup")             await handleLookup(req, res);
      else if (url === "/claude")             await handleClaude(req, res);
      else if (url === "/photos")             await handlePhotos(req, res);
      else if (url === "/zone")               await handleZone(req, res);
      else if (url === "/user/status")        await handleUserStatus(req, res);
      else if (url === "/garden")             await handleGardenSave(req, res);
      else if (url === "/stripe/checkout")    await handleCreateCheckout(req, res);
      else sendJSON(res, 404, { error: "API route not found" });
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Error on ${url}:`, e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // ── GET /garden ────────────────────────────────────────
  if (req.method === "GET" && url === "/garden") {
    try { await handleGardenGet(req, res); }
    catch (e) { sendJSON(res, 500, { error: e.message }); }
    return;
  }

  sendJSON(res, 405, { error: "Method not allowed" });
});

// Boot
initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║           🌸  BloomWise Server v2                    ║
  ║                                                      ║
  ║   Frontend:  http://localhost:${PORT}                   ║
  ║                                                      ║
  ║   API routes:                                        ║
  ║     POST  /recommendations   (AI plant picks)        ║
  ║     POST  /lookup            (plant fit check)       ║
  ║     POST  /photos            (fetch plant photos)    ║
  ║     POST  /zone              (detect hardiness zone) ║
  ║     GET   /garden            (load saved garden)     ║
  ║     POST  /garden            (save garden)           ║
  ║     GET   /user/status       (usage & pro status)    ║
  ║     POST  /stripe/checkout   (start subscription)    ║
  ║     POST  /stripe/webhook    (Stripe events)         ║
  ║     GET   /health                                    ║
  ║                                                      ║
  ║   Claude:  ${ANTHROPIC_KEY ? "✅ configured" : "❌ ANTHROPIC_API_KEY not set"}                    ║
  ║   Database:${pool ? "✅ connected" : "❌ DATABASE_URL not set"}                       ║
  ║   Stripe:  ${stripe ? "✅ configured" : "❌ STRIPE_SECRET_KEY not set"}                    ║
  ║   Perenual:${PERENUAL_KEY ? "✅ configured" : "⚪ optional — using Wikipedia"}          ║
  ║                                                      ║
  ║   Pro plan: ${PRO_PRICE}                                  ║
  ╚══════════════════════════════════════════════════════╝
    `);
  });
});
