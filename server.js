// BloomWise — Full Stack Server
// Serves frontend + API + Stripe payments from one Railway deployment
//
// Railway environment variables:
//   DATABASE_URL           (auto-set by Railway PostgreSQL)
//   ANTHROPIC_API_KEY      sk-ant-...
//   STRIPE_SECRET_KEY      sk_live_... or sk_test_...
//   STRIPE_WEBHOOK_SECRET  whsec_...
//   STRIPE_PRICE_ID        price_...
//   STRIPE_SUCCESS_URL     https://your-app.up.railway.app/?success=1
//   STRIPE_CANCEL_URL      https://your-app.up.railway.app
//   GOOGLE_PLACES_API_KEY  (optional — nursery finder)
//   PERENUAL_API_KEY       (optional — better plant photos)
//   MODEL                  claude-haiku-4-5-20251001 (optional)

"use strict";

const http   = require("http");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

// ── Config ────────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const STRIPE_KEY    = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_ID       = process.env.STRIPE_PRICE_ID;
const STRIPE_SUCCESS_URL    = process.env.STRIPE_SUCCESS_URL || `http://localhost:${PORT}/?success=1`;
const STRIPE_CANCEL_URL     = process.env.STRIPE_CANCEL_URL  || `http://localhost:${PORT}/`;
const MODEL         = process.env.MODEL || "claude-haiku-4-5-20251001";
const FRONTEND      = path.join(__dirname, "index.html");
const FREE_RECS_PER_DAY = 3;

// ── PostgreSQL ────────────────────────────────────────────
let db;

async function connectDB() {
  if (!process.env.DATABASE_URL) {
    console.warn("⚠️  DATABASE_URL not set — using in-memory fallback");
    return;
  }
  db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      uid TEXT PRIMARY KEY,
      is_pro BOOLEAN NOT NULL DEFAULT FALSE,
      stripe_customer_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS usage (
      uid TEXT NOT NULL,
      usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
      rec_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (uid, usage_date)
    );
    CREATE TABLE IF NOT EXISTS gardens (
      uid TEXT PRIMARY KEY,
      plants JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("✅ PostgreSQL connected and schema ready");
}

// In-memory fallback maps
const _memUsers   = new Map();
const _memUsage   = new Map();
const _memGardens = new Map();

async function dbIsProUser(uid) {
  if (!db) return _memUsers.get(uid)?.is_pro || false;
  const r = await db.query("SELECT is_pro FROM users WHERE uid=$1", [uid]);
  return r.rows[0]?.is_pro || false;
}

async function dbSetPro(uid, isPro, customerId = null) {
  if (!db) { _memUsers.set(uid, { is_pro: isPro }); return; }
  await db.query(
    `INSERT INTO users (uid, is_pro, stripe_customer_id) VALUES ($1,$2,$3)
     ON CONFLICT (uid) DO UPDATE SET is_pro=$2, stripe_customer_id=COALESCE($3, users.stripe_customer_id)`,
    [uid, isPro, customerId]
  );
}

async function dbCheckFreeLimit(uid) {
  if (!db) {
    const today = new Date().toDateString();
    const e = _memUsage.get(uid) || { date: today, count: 0 };
    if (e.date !== today) { e.date = today; e.count = 0; }
    e.count++;
    _memUsage.set(uid, e);
    return { allowed: e.count <= FREE_RECS_PER_DAY, used: e.count, limit: FREE_RECS_PER_DAY };
  }
  const r = await db.query(
    `INSERT INTO usage (uid, usage_date, rec_count) VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (uid, usage_date) DO UPDATE SET rec_count = usage.rec_count + 1
     RETURNING rec_count`,
    [uid]
  );
  const count = r.rows[0].rec_count;
  return { allowed: count <= FREE_RECS_PER_DAY, used: count, limit: FREE_RECS_PER_DAY };
}

async function dbGetGarden(uid) {
  if (!db) return _memGardens.get(uid) || [];
  const r = await db.query("SELECT plants FROM gardens WHERE uid=$1", [uid]);
  return r.rows[0]?.plants || [];
}

async function dbSaveGarden(uid, plants) {
  if (!db) { _memGardens.set(uid, plants); return; }
  await db.query(
    `INSERT INTO gardens (uid, plants, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (uid) DO UPDATE SET plants=$2::jsonb, updated_at=NOW()`,
    [uid, JSON.stringify(plants)]
  );
}

// ── Rate limiter ──────────────────────────────────────────
const _rates = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const e = _rates.get(ip) || { count: 0, start: now };
  if (now - e.start > 60000) { e.count = 0; e.start = now; }
  e.count++;
  _rates.set(ip, e);
  return e.count > 30;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of _rates) if (now - e.start > 120000) _rates.delete(ip);
}, 5 * 60 * 1000);

// ── HTTP helpers ──────────────────────────────────────────
function getIP(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function sendHTML(res) {
  fs.readFile(FRONTEND, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

function readBodyRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readBody(req, maxSize = 25000) {
  const buf = await readBodyRaw(req);
  if (buf.length > maxSize) throw new Error("Request too large");
  try { return JSON.parse(buf.toString()); }
  catch { throw new Error("Invalid JSON body"); }
}

async function readBodyLarge(req) {
  return readBody(req, 10 * 1024 * 1024); // 10MB for image uploads
}

// ── Anthropic ─────────────────────────────────────────────
function callAnthropic(messages, maxTokens = 1800) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages });
    const req = https.request({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
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

function ai(prompt, maxTokens = 1800) {
  return callAnthropic([{ role: "user", content: prompt }], maxTokens);
}

function parseJSON(text, type = "array") {
  const clean = text.replace(/```json|```/gi, "").trim();
  const s = clean.indexOf(type === "array" ? "[" : "{");
  const e = type === "array" ? clean.lastIndexOf("]") : clean.lastIndexOf("}");
  if (s > -1 && e > -1) return JSON.parse(clean.slice(s, e + 1));
  throw new Error("Could not parse JSON from AI response");
}

// ── HTTP GET helper ───────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "BloomWise/1.0" } }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

// ── Stripe helper ─────────────────────────────────────────
function stripeReq(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? new URLSearchParams(body).toString() : "";
    const req = https.request({
      hostname: "api.stripe.com", path: endpoint, method,
      headers: {
        "Authorization": `Bearer ${STRIPE_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ══════════════════════════════════════════════════════════

async function handleRecommendations(req, res) {
  const p = await readBody(req);
  const uid = p.uid || "anonymous";
  const isPro = await dbIsProUser(uid);

  if (!isPro) {
    const { allowed, used, limit } = await dbCheckFreeLimit(uid);
    if (!allowed) {
      return sendJSON(res, 402, {
        error: "free_limit_reached",
        message: `You've used all ${limit} free recommendations today. Upgrade to BloomWise Pro for unlimited access.`,
        used, limit,
      });
    }
  }

  const prompt = `You are a professional horticulturist and landscape designer. Recommend exactly 6 plants perfectly suited to this client. Return ONLY a valid JSON array, nothing else.

Client profile:
Location: ${p.location || "Not specified"} | Country: ${p.country || "unknown"} | Zone: ${p.zone || "unknown"} | Season: ${p.season || "not specified"} | Climate: ${p.climate || "not specified"}
Sun: ${p.sun || "not specified"} | Soil: ${p.soil || "not specified"} | pH: ${p.ph || "unknown"} | Drainage: ${p.drainage || "unknown"}
Microclimate: ${p.microclimate || "none"} | Water: ${p.water || "not specified"} | Restrictions: ${p.wrestrict || "none"}
Rainfall: ${p.rainfall || "unknown"} | Irrigation: ${p.irrigation || "none"} | Style: ${p.style || "not specified"}
Colors: ${p.colors || "no preference"} | Priorities: ${p.priorities || "none"} | Notes: ${p.notes || "none"}

Return a JSON array where each object has exactly these fields:
[{
  "name": "Common Name",
  "scientific": "Genus species",
  "sun": "sun requirement (short)",
  "water": "water requirement (short)",
  "soil": "ideal soil (short)",
  "fit": "why it matches this site (5-8 words)",
  "planting_season": "best planting time e.g. Fall (Sep-Nov)",
  "description": "3 sentences: why it thrives here, standout qualities, one care tip",
  "mature_height": "e.g. 3-4 ft",
  "mature_spread": "e.g. 2-3 ft",
  "spacing": "e.g. 18-24 in apart",
  "growth_rate": "slow / moderate / fast",
  "lifespan": "annual / biennial / perennial"
}]`;

  const text = await ai(prompt, 2000);
  const plants = parseJSON(text, "array");
  sendJSON(res, 200, { plants, pro: isPro });
}

async function handleLookup(req, res) {
  const { plant, site } = await readBody(req);
  if (!plant) return sendJSON(res, 400, { error: "plant name required" });

  const siteInfo = site
    ? `User site — Location: ${site.location}, Zone: ${site.zone}, Season: ${site.season}, Sun: ${site.sun}, Soil: ${site.soil}, pH: ${site.ph}, Drainage: ${site.drainage}, Water: ${site.water}, Restrictions: ${site.wrestrict}, Style: ${site.style}, Priorities: ${site.priorities}`
    : "No site profile provided — give general info and use neutral status for all requirements.";

  const prompt = `You are an expert horticulturist. Evaluate "${plant}" as a garden plant.
${siteInfo}
Return ONLY a valid JSON object:
{
  "name": "common name",
  "scientific": "Genus species",
  "verdict": "green",
  "verdict_label": "Great choice",
  "summary": "2-3 sentence honest assessment for this site",
  "planting_season": "best season with months",
  "requirements": [
    {"label": "Sun", "value": "what it needs", "status": "ok", "note": "site match note"},
    {"label": "Water", "value": "what it needs", "status": "ok", "note": "note"},
    {"label": "Soil", "value": "what it needs", "status": "ok", "note": "note"},
    {"label": "Hardiness zone", "value": "zones it thrives in", "status": "ok", "note": "note"},
    {"label": "Maintenance", "value": "low/moderate/high", "status": "neutral", "note": "details"},
    {"label": "Mature size", "value": "height x spread", "status": "neutral", "note": "note"}
  ],
  "special_requirements": ["req1", "req2", "req3"],
  "pro_tip": "one practical tip for success"
}
verdict must be green, yellow, or red. status must be ok, warn, bad, or neutral.`;

  const text = await ai(prompt, 1200);
  const result = parseJSON(text, "object");
  sendJSON(res, 200, { result });
}

async function handleIdentifyPlant(req, res) {
  const { image, mimeType } = await readBodyLarge(req);
  if (!image) return sendJSON(res, 400, { error: "image is required" });

  const prompt = `You are an expert botanist. Identify the plant in this photo.
Return ONLY a valid JSON object, nothing else:
{
  "identified": true,
  "common_name": "Common Name",
  "scientific_name": "Genus species",
  "family": "Plant family",
  "confidence": "high",
  "description": "2-3 sentences about this plant",
  "care": {
    "sun": "sun requirements",
    "water": "watering needs",
    "soil": "soil preference",
    "hardiness": "USDA zones"
  },
  "mature_height": "e.g. 3-5 ft",
  "mature_spread": "e.g. 2-4 ft",
  "growth_rate": "slow/moderate/fast",
  "lifespan": "annual/perennial/biennial",
  "notes": "special characteristics, toxicity warnings, or interesting facts",
  "edible": false,
  "toxic_to_pets": false
}
If you cannot identify the plant, return: {"identified": false, "reason": "brief explanation"}
confidence must be high, medium, or low.`;

  const messages = [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: mimeType || "image/jpeg", data: image } },
      { type: "text", text: prompt },
    ],
  }];

  const text = await callAnthropic(messages, 1000);
  const plant = parseJSON(text, "object");
  sendJSON(res, 200, { plant });
}

async function handleShoppingList(req, res) {
  const p = await readBody(req);
  const plantNames = (p.plants || []).map(pl => pl.name).filter(Boolean).join(", ");

  const prompt = `You are an expert horticulturist and garden planner. Generate a practical shopping list for this garden setup. Return ONLY a valid JSON object.

Client profile:
Location: ${p.location || "Not specified"} | Zone: ${p.zone || "unknown"} | Sun: ${p.sun || "not specified"}
Soil: ${p.soil || "not specified"} | Water: ${p.water || "not specified"} | Style: ${p.style || "not specified"}
Priorities: ${p.priorities || "none"} | Notes: ${p.notes || "none"}
Plants selected: ${plantNames || "not specified"}

{
  "intro": "1-2 sentence summary of what this garden setup needs",
  "categories": [
    {
      "name": "Plants",
      "icon": "🌱",
      "items": [
        {"name": "item name", "detail": "quantity or spec", "tip": "brief buying tip", "priority": "essential"}
      ]
    },
    {"name": "Soil & Amendments", "icon": "🪱", "items": [...]},
    {"name": "Tools", "icon": "🛠️", "items": [...]},
    {"name": "Extras", "icon": "✨", "items": [...]}
  ]
}
priority must be "essential" or "optional". Give 3-6 items per category. Be specific with product names where helpful.`;

  const text = await ai(prompt, 2000);
  const list = parseJSON(text, "object");
  sendJSON(res, 200, { list });
}

async function handlePhotos(req, res) {
  const { name, scientific } = await readBody(req);
  if (!name) return sendJSON(res, 400, { error: "name is required" });

  const PERENUAL_KEY = process.env.PERENUAL_API_KEY;

  // Try Perenual first
  if (PERENUAL_KEY) {
    try {
      for (const q of [scientific, name].filter(Boolean)) {
        const resp = await httpGet(
          `https://perenual.com/api/species-list?key=${PERENUAL_KEY}&q=${encodeURIComponent(q)}&per_page=3`
        );
        const photos = [];
        for (const plant of (resp.data || []).slice(0, 3)) {
          const img = plant.default_image;
          if (img) {
            const url = img.medium_url || img.regular_url || img.thumbnail;
            if (url && !url.includes("upgrade_access") && !photos.includes(url)) photos.push(url);
          }
          if (photos.length >= 2) break;
        }
        if (photos.length > 0) return sendJSON(res, 200, { photos, source: "perenual" });
      }
    } catch (e) { console.warn("Perenual error:", e.message); }
  }

  // Fall back to Wikipedia
  try {
    const genus = (scientific || "").split(" ")[0];
    const photos = [];
    for (const q of [scientific, genus, name].filter(Boolean)) {
      if (photos.length >= 2) break;
      const d = await httpGet(
        `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(q)}&prop=pageimages&format=json&pithumbsize=600&origin=*`
      );
      const pages = d.query?.pages;
      const url = pages ? Object.values(pages)[0]?.thumbnail?.source || null : null;
      if (url && !photos.includes(url)) photos.push(url);
    }
    return sendJSON(res, 200, { photos, source: "wikipedia" });
  } catch (e) {
    return sendJSON(res, 200, { photos: [], source: "none" });
  }
}

async function handleZone(req, res) {
  const { location } = await readBody(req);
  if (!location) return sendJSON(res, 400, { error: "location is required" });

  try {
    const geo = await httpGet(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`
    );
    if (!geo.results?.length) return sendJSON(res, 200, { zone: null, message: "Location not found" });

    const { latitude, longitude, country_code, name, admin1 } = geo.results[0];
    const country = (country_code || "").toUpperCase();
    const displayName = [name, admin1, country_code].filter(Boolean).join(", ");

    let minTempC = null;
    try {
      const climate = await httpGet(
        `https://climate-api.open-meteo.com/v1/climate?latitude=${latitude}&longitude=${longitude}&start_date=1991-01-01&end_date=2020-12-31&models=EC_Earth3P_HR&daily=temperature_2m_min&timezone=auto`
      );
      if (climate.daily?.temperature_2m_min) {
        const temps = climate.daily.temperature_2m_min.filter(t => t !== null);
        if (temps.length > 0) minTempC = Math.min(...temps);
      }
    } catch (e) { /* estimate from latitude below */ }

    if (minTempC === null) {
      const a = Math.abs(latitude);
      minTempC = a < 10 ? 15 : a < 20 ? 5 : a < 30 ? -2 : a < 40 ? -10 : a < 50 ? -20 : a < 60 ? -32 : -45;
    }

    const minTempF = minTempC * 9 / 5 + 32;
    const RHS = new Set(["GB","IE","NL","BE","FR","DE","AT","CH","DK","NO","SE","FI","IS","PT","ES","IT","PL","CZ","SK","HU","RO","HR","SI","BG","GR","TR"]);
    const AU  = new Set(["AU","NZ"]);

    let zoneLabel, system;
    if (AU.has(country)) {
      system = "Australian";
      zoneLabel = minTempC >= 18 ? "Zone 1 — Tropical" : minTempC >= 10 ? "Zone 2 — Subtropical" : minTempC >= 2 ? "Zone 3 — Warm temperate" : minTempC >= -5 ? "Zone 4 — Cool temperate" : minTempC >= -12 ? "Zone 5 — Cold temperate" : minTempC >= -20 ? "Zone 6 — Alpine" : "Zone 7 — Sub-alpine";
    } else if (RHS.has(country)) {
      system = "RHS";
      zoneLabel = minTempC >= 15 ? "H1a — Heated glasshouse" : minTempC >= 10 ? "H1b — Warm glasshouse" : minTempC >= 5 ? "H1c — Cool glasshouse" : minTempC >= 0 ? "H2 — Half hardy" : minTempC >= -5 ? "H3 — Hardy in sheltered spots" : minTempC >= -10 ? "H4 — Hardy through most of UK" : minTempC >= -15 ? "H5 — Hardy in most places" : minTempC >= -20 ? "H6 — Hardy in all of UK" : "H7 — Very hardy";
    } else {
      system = "USDA";
      zoneLabel = minTempF < -60 ? "Zone 1" : minTempF < -50 ? "Zone 2" : minTempF < -40 ? "Zone 3" : minTempF < -30 ? "Zone 4" : minTempF < -20 ? "Zone 5" : minTempF < -10 ? "Zone 6" : minTempF < 0 ? "Zone 7" : minTempF < 10 ? "Zone 8" : minTempF < 20 ? "Zone 9" : minTempF < 30 ? "Zone 10" : minTempF < 40 ? "Zone 11" : "Zone 12";
    }

    sendJSON(res, 200, { zone: zoneLabel, system, country, displayName, latitude, longitude });
  } catch (e) {
    console.warn("Zone error:", e.message);
    sendJSON(res, 200, { zone: null, message: e.message });
  }
}

async function handleNurseries(req, res) {
  const { location } = await readBody(req);
  if (!location) return sendJSON(res, 400, { error: "location required" });

  const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!PLACES_KEY) return sendJSON(res, 200, { nurseries: [], error: "Google Places not configured" });

  try {
    const geo = await httpGet(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${PLACES_KEY}`
    );
    if (!geo.results?.length) return sendJSON(res, 200, { nurseries: [], error: "Location not found" });

    const { lat, lng } = geo.results[0].geometry.location;
    const places = await httpGet(
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=40000&keyword=plant+nursery&type=store&key=${PLACES_KEY}`
    );

    const nurseries = (places.results || []).slice(0, 10).map(p => ({
      name:     p.name,
      address:  p.vicinity,
      rating:   p.rating || null,
      reviews:  p.user_ratings_total || 0,
      open:     p.opening_hours?.open_now ?? null,
      lat:      p.geometry.location.lat,
      lng:      p.geometry.location.lng,
      place_id: p.place_id,
    }));

    sendJSON(res, 200, { nurseries, center: { lat, lng } });
  } catch (e) {
    console.warn("Nursery error:", e.message);
    sendJSON(res, 200, { nurseries: [], error: e.message });
  }
}

async function handleGetGarden(req, res) {
  const { uid } = await readBody(req);
  if (!uid) return sendJSON(res, 400, { error: "uid required" });
  const plants = await dbGetGarden(uid);
  sendJSON(res, 200, { plants });
}

async function handleSaveGarden(req, res) {
  const { uid, plants } = await readBodyLarge(req); // plants array can be large
  if (!uid) return sendJSON(res, 400, { error: "uid required" });
  await dbSaveGarden(uid, plants || []);
  sendJSON(res, 200, { ok: true });
}

async function handleCheckPro(req, res) {
  const { uid } = await readBody(req);
  if (!uid) return sendJSON(res, 400, { error: "uid required" });
  const pro = await dbIsProUser(uid);
  sendJSON(res, 200, { pro });
}

async function handleCreateCheckout(req, res) {
  if (!STRIPE_KEY)      return sendJSON(res, 500, { error: "Stripe not configured" });
  if (!STRIPE_PRICE_ID) return sendJSON(res, 500, { error: "STRIPE_PRICE_ID not set" });

  const { uid } = await readBody(req);
  if (!uid) return sendJSON(res, 400, { error: "uid required" });

  const session = await stripeReq("POST", "/v1/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    success_url: `${STRIPE_SUCCESS_URL}&uid=${uid}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: STRIPE_CANCEL_URL,
    "metadata[uid]": uid,
    "subscription_data[metadata][uid]": uid,
  });

  if (session.error) return sendJSON(res, 400, { error: session.error.message });
  sendJSON(res, 200, { url: session.url });
}

async function handleVerifySession(req, res) {
  if (!STRIPE_KEY) return sendJSON(res, 500, { error: "Stripe not configured" });
  const { session_id, uid } = await readBody(req);
  if (!session_id || !uid) return sendJSON(res, 400, { error: "session_id and uid required" });

  const session = await stripeReq("GET", `/v1/checkout/sessions/${session_id}`);
  if (session.payment_status === "paid" || session.status === "complete") {
    await dbSetPro(uid, true, session.customer);
    sendJSON(res, 200, { pro: true });
  } else {
    sendJSON(res, 200, { pro: false });
  }
}

async function handleStripeWebhook(req, res) {
  if (!STRIPE_WEBHOOK_SECRET) return sendJSON(res, 400, { error: "Webhook secret not configured" });
  const rawBody = await readBodyRaw(req);
  const sig = req.headers["stripe-signature"] || "";

  try {
    const parts = sig.split(",");
    const ts  = parts.find(p => p.startsWith("t="))?.slice(2);
    const v1  = parts.find(p => p.startsWith("v1="))?.slice(3);
    const expected = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET)
      .update(`${ts}.${rawBody}`).digest("hex");
    if (expected !== v1) return sendJSON(res, 400, { error: "Invalid signature" });
  } catch (e) {
    return sendJSON(res, 400, { error: "Signature verification failed" });
  }

  const event = JSON.parse(rawBody.toString());
  if (event.type === "checkout.session.completed") {
    const uid = event.data.object.metadata?.uid;
    const cid = event.data.object.customer;
    if (uid) await dbSetPro(uid, true, cid);
  }
  if (event.type === "customer.subscription.deleted") {
    const uid = event.data.object.metadata?.uid;
    if (uid) await dbSetPro(uid, false);
  }
  sendJSON(res, 200, { received: true });
}

// ══════════════════════════════════════════════════════════
// MAIN SERVER
// ══════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0].replace(/\/+$/, "") || "/";

  // Log API requests
  if (url !== "/" && url !== "/health") {
    console.log(`[${new Date().toISOString()}] ${req.method} ${url}`);
  }

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    return res.end();
  }

  // GET — serve frontend or health check
  if (req.method === "GET") {
    if (url === "/health") return sendJSON(res, 200, { status: "ok", model: MODEL, db: !!db });
    return sendHTML(res);
  }

  // POST — API
  if (req.method === "POST") {

    // Stripe webhook — raw body, skip JSON parsing
    if (url === "/stripe-webhook") {
      try { await handleStripeWebhook(req, res); }
      catch (e) { sendJSON(res, 500, { error: e.message }); }
      return;
    }

    // Free routes — no Anthropic needed, no rate limit
    const FREE = {
      "/photos":          handlePhotos,
      "/zone":            handleZone,
      "/check-pro":       handleCheckPro,
      "/create-checkout": handleCreateCheckout,
      "/verify-session":  handleVerifySession,
      "/garden/get":      handleGetGarden,
      "/garden/save":     handleSaveGarden,
      "/shopping-list":   handleShoppingList,
      "/nurseries":       handleNurseries,
    };
    if (FREE[url]) {
      try { await FREE[url](req, res); }
      catch (e) {
        console.error(`Error on ${url}:`, e.message);
        sendJSON(res, 500, { error: e.message });
      }
      return;
    }

    // AI routes — need API key + rate limit
    if (!ANTHROPIC_KEY) {
      return sendJSON(res, 500, { error: "ANTHROPIC_API_KEY not configured in Railway environment variables" });
    }
    if (isRateLimited(getIP(req))) {
      return sendJSON(res, 429, { error: "Too many requests — please wait a moment and try again" });
    }

    const AI = {
      "/recommendations": handleRecommendations,
      "/lookup":          handleLookup,
      "/identify-plant":  handleIdentifyPlant,
    };
    if (AI[url]) {
      try { await AI[url](req, res); }
      catch (e) {
        console.error(`Error on ${url}:`, e.message);
        sendJSON(res, 500, { error: e.message });
      }
      return;
    }

    return sendJSON(res, 404, { error: "Not found" });
  }

  sendJSON(res, 405, { error: "Method not allowed" });
});

// ── Start ─────────────────────────────────────────────────
connectDB()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`
  ╔══════════════════════════════════════════════╗
  ║         🌸  BloomWise Server                 ║
  ║                                              ║
  ║   http://localhost:${PORT}                      ║
  ║                                              ║
  ║   Anthropic:  ${ANTHROPIC_KEY        ? "✅ configured" : "❌ ANTHROPIC_API_KEY missing"}    ║
  ║   Stripe:     ${STRIPE_KEY           ? "✅ configured" : "⚠️  not set"}                  ║
  ║   Database:   ${process.env.DATABASE_URL ? "✅ PostgreSQL" : "⚠️  in-memory fallback"}         ║
  ║   Perenual:   ${process.env.PERENUAL_API_KEY ? "✅ configured" : "⚠️  not set"}                  ║
  ║   Places:     ${process.env.GOOGLE_PLACES_API_KEY ? "✅ configured" : "⚠️  not set"}                  ║
  ║                                              ║
  ║   Free tier:  ${FREE_RECS_PER_DAY} recs/day per user         ║
  ╚══════════════════════════════════════════════╝
      `);
    });
  })
  .catch(err => {
    console.error("DB connection failed:", err.message, "— starting without database");
    server.listen(PORT);
  });
