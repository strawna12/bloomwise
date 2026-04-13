"use strict";
// BloomWise — Full Stack Server
// Railway env vars needed:
//   DATABASE_URL, ANTHROPIC_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//   STRIPE_PRICE_ID, STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL,
//   RESEND_API_KEY, FROM_EMAIL, APP_URL,
//   GOOGLE_PLACES_API_KEY (optional), PERENUAL_API_KEY (optional), MODEL (optional)

const http   = require("http");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { Client } = require("pg");
const bcrypt     = require("bcryptjs");

// ── Config ────────────────────────────────────────────────
const PORT               = process.env.PORT || 3000;
const ANTHROPIC_KEY      = process.env.ANTHROPIC_API_KEY;
const STRIPE_KEY         = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SEC = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_ID    = process.env.STRIPE_PRICE_ID;
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || `http://localhost:${PORT}/?success=1`;
const STRIPE_CANCEL_URL  = process.env.STRIPE_CANCEL_URL  || `http://localhost:${PORT}/`;
const RESEND_KEY         = process.env.RESEND_API_KEY;
const FROM_EMAIL         = process.env.FROM_EMAIL || "hello@bloomwise.app";
const APP_URL            = process.env.APP_URL    || `http://localhost:${PORT}`;
const MODEL              = process.env.MODEL      || "claude-haiku-4-5-20251001";
const FRONTEND           = path.join(__dirname, "index.html");
const FREE_RECS_PER_DAY  = 3;

// ── PostgreSQL ────────────────────────────────────────────
let db;

async function connectDB() {
  if (!process.env.DATABASE_URL) {
    console.warn("⚠️  DATABASE_URL not set — using in-memory fallback");
    return;
  }
  db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      uid TEXT PRIMARY KEY,
      is_pro BOOLEAN NOT NULL DEFAULT FALSE,
      stripe_customer_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS usage (
      uid        TEXT NOT NULL,
      usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
      rec_count  INTEGER NOT NULL DEFAULT 0,
      feature    TEXT NOT NULL DEFAULT 'recommendations',
      PRIMARY KEY (uid, usage_date, feature)
    );
    CREATE TABLE IF NOT EXISTS gardens (
      uid TEXT PRIMARY KEY,
      plants JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      name          TEXT,
      password_hash TEXT,
      uid           TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      uid        TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Magic tokens kept for optional future use
    CREATE TABLE IF NOT EXISTS magic_tokens (
      token      TEXT PRIMARY KEY,
      email      TEXT NOT NULL,
      uid        TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("✅ PostgreSQL connected and schema ready");
}

// ── In-memory fallbacks ───────────────────────────────────
const _mem = { users: new Map(), usage: new Map(), gardens: new Map() };

async function dbIsProUser(uid) {
  if (!db) return _mem.users.get(uid)?.is_pro || false;
  const r = await db.query("SELECT is_pro FROM users WHERE uid=$1", [uid]);
  return r.rows[0]?.is_pro || false;
}

async function dbSetPro(uid, isPro, customerId = null) {
  if (!db) { _mem.users.set(uid, { is_pro: isPro }); return; }
  await db.query(
    `INSERT INTO users (uid, is_pro, stripe_customer_id) VALUES ($1,$2,$3)
     ON CONFLICT (uid) DO UPDATE SET is_pro=$2,
     stripe_customer_id=COALESCE($3, users.stripe_customer_id)`,
    [uid, isPro, customerId]
  );
}

// ── Free tier limits ──────────────────────────────────────
const FREE_LIMITS = {
  recommendations: 3,   // per week
  lookup:          2,   // per week
  identify:        3,   // per week
};

async function dbCheckLimit(uid, feature) {
  const limit = FREE_LIMITS[feature];
  if (!db) {
    const week  = getWeekKey();
    const key   = `${uid}:${feature}`;
    const e     = _mem.usage.get(key) || { week, count: 0 };
    if (e.week !== week) { e.week = week; e.count = 0; }
    e.count++;
    _mem.usage.set(key, e);
    return { allowed: e.count <= limit, used: e.count, limit, feature };
  }
  const r = await db.query(
    `INSERT INTO usage (uid, usage_date, rec_count, feature)
     VALUES ($1, date_trunc('week', CURRENT_DATE), 1, $2)
     ON CONFLICT (uid, usage_date, feature)
     DO UPDATE SET rec_count = usage.rec_count + 1
     RETURNING rec_count`,
    [uid, feature]
  );
  const count = r.rows[0].rec_count;
  return { allowed: count <= limit, used: count, limit, feature };
}

function getWeekKey() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  return new Date(d.setDate(diff)).toDateString();
}

// Keep old name as alias
async function dbCheckFreeLimit(uid) { return dbCheckLimit(uid, 'recommendations'); }

async function dbGetGarden(uid) {
  if (!db) return _mem.gardens.get(uid) || [];
  const r = await db.query("SELECT plants FROM gardens WHERE uid=$1", [uid]);
  return r.rows[0]?.plants || [];
}

async function dbSaveGarden(uid, plants) {
  if (!db) { _mem.gardens.set(uid, plants); return; }
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
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0].trim();
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

async function readBody(req, maxBytes = 25000) {
  const buf = await readBodyRaw(req);
  if (buf.length > maxBytes) throw new Error("Request too large");
  try { return JSON.parse(buf.toString()); }
  catch { throw new Error("Invalid JSON body"); }
}

// ── Anthropic ─────────────────────────────────────────────
async function callAnthropic(messages, maxTokens = 1800) {
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
          const p = JSON.parse(data);
          if (p.error) return reject(new Error(p.error.message));
          resolve((p.content || []).map(b => b.text || "").join(""));
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
function httpGet(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "BloomWise/1.0" } }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    });
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
        message: `You've used all ${limit} free recommendations this week. Upgrade to BloomWise Pro for unlimited access.`,
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

[{
  "name": "Common Name",
  "scientific": "Genus species",
  "sun": "sun requirement",
  "water": "water requirement",
  "soil": "ideal soil",
  "fit": "why it matches (5-8 words)",
  "planting_season": "e.g. Fall (Sep-Nov)",
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
  const { plant, site, uid } = await readBody(req);
  if (!plant) return sendJSON(res, 400, { error: "plant name required" });

  const isPro = uid ? await dbIsProUser(uid) : false;
  if (!isPro) {
    const { allowed, used, limit } = await dbCheckLimit(uid || 'anonymous', 'lookup');
    if (!allowed) {
      return sendJSON(res, 402, {
        error: "free_limit_reached",
        feature: "lookup",
        message: `You've used all ${limit} free plant lookups this week. Upgrade to Pro for unlimited access.`,
        used, limit,
      });
    }
  }

  const siteInfo = site
    ? `User site — Location: ${site.location}, Zone: ${site.zone}, Season: ${site.season}, Sun: ${site.sun}, Soil: ${site.soil}, pH: ${site.ph}, Drainage: ${site.drainage}, Water: ${site.water}, Restrictions: ${site.wrestrict}, Style: ${site.style}`
    : "No site profile — give general info, use neutral status for all requirements.";

  const prompt = `You are an expert horticulturist. Evaluate "${plant}" as a garden plant.
${siteInfo}
Return ONLY a valid JSON object:
{
  "name": "common name",
  "scientific": "Genus species",
  "verdict": "green",
  "verdict_label": "Great choice",
  "summary": "2-3 sentence honest assessment",
  "planting_season": "best season with months",
  "requirements": [
    {"label": "Sun", "value": "needs", "status": "ok", "note": "note"},
    {"label": "Water", "value": "needs", "status": "ok", "note": "note"},
    {"label": "Soil", "value": "needs", "status": "ok", "note": "note"},
    {"label": "Hardiness zone", "value": "zones", "status": "ok", "note": "note"},
    {"label": "Maintenance", "value": "low/moderate/high", "status": "neutral", "note": "details"},
    {"label": "Mature size", "value": "height x spread", "status": "neutral", "note": "note"}
  ],
  "special_requirements": ["req1", "req2"],
  "pro_tip": "one practical tip"
}
verdict: green/yellow/red. status: ok/warn/bad/neutral.`;

  const text = await ai(prompt, 1400);

  // Robust JSON extraction — handles truncated responses by closing open braces
  let result;
  try {
    result = parseJSON(text, "object");
  } catch(e) {
    // Try to recover truncated JSON by finding the last complete field
    const clean = text.replace(/```json|```/gi, "").trim();
    const start = clean.indexOf("{");
    if (start === -1) throw new Error("No plant data returned — please try again");
    let partial = clean.slice(start);
    // Count open braces to find how many we need to close
    let opens = 0, closes = 0;
    for (const ch of partial) { if (ch === "{") opens++; if (ch === "}") closes++; }
    partial += "}".repeat(Math.max(0, opens - closes));
    try { result = JSON.parse(partial); }
    catch(e2) { throw new Error("Could not parse plant data — please try again"); }
  }

  sendJSON(res, 200, { result });
}

async function handleGardenAdvisor(req, res) {
  const { question, context } = await readBody(req);
  if (!question) return sendJSON(res, 400, { error: "question required" });

  const prompt = `You are an expert permaculture designer, organic gardener, and horticulturist with decades of hands-on experience. Answer the following gardening question with practical, actionable advice.

${context ? `Gardener's context: ${context}` : ''}

Question: ${question}

Provide a thorough, expert answer. Include:
- Direct practical advice they can act on immediately
- Organic/natural solutions where relevant (especially for pest control)
- Specific plant names, techniques, or products where helpful
- Any important warnings or common mistakes to avoid
- A quick "bottom line" summary at the end

Write in a warm, knowledgeable tone — like advice from an experienced gardening mentor. Use markdown formatting with **bold** for key terms and bullet points for lists.`;

  const text = await ai(prompt, 1500);
  sendJSON(res, 200, { answer: text });
}

async function handlePlantingCalendar(req, res) {
  const { location, zone, climate, sun, soil, water, style, priorities, notes } = await readBody(req);

  const prompt = `You are an expert horticulturist. Create a month-by-month planting calendar for this gardener. Return ONLY a valid JSON object, nothing else — no introduction, no explanation, no markdown.

Gardener profile:
Location: ${location || 'Not specified'} | Zone: ${zone || 'unknown'} | Climate: ${climate || 'not specified'}
Sun: ${sun || 'not specified'} | Soil: ${soil || 'not specified'} | Water: ${water || 'not specified'}
Style: ${style || 'not specified'} | Priorities: ${priorities || 'none'} | Notes: ${notes || 'none'}

Return this exact JSON structure with all 12 months:
{
  "title": "Planting Calendar for ${location || 'Your Garden'}",
  "zone": "${zone || 'your zone'}",
  "months": [
    {
      "month": "January",
      "emoji": "❄️",
      "season": "Winter",
      "sow_indoors": ["item 1", "item 2"],
      "sow_outdoors": ["item 1"],
      "plant_out": ["item 1"],
      "harvest": ["item 1", "item 2"],
      "tasks": ["task 1", "task 2"],
      "tip": "one practical tip for this month and location"
    }
  ]
}

Tailor specifically to their zone and priorities. If edibles are a priority focus on vegetables. Be specific. Return JSON only.`;

  const text = await ai(prompt, 2500);
  const clean = text.replace(/```json|```/gi, '').trim();
  const s = clean.indexOf('{');
  const e = clean.lastIndexOf('}');
  if (s === -1 || e === -1) throw new Error('Could not parse calendar response');
  const calendar = JSON.parse(clean.slice(s, e + 1));
  sendJSON(res, 200, { calendar });
}

async function handleLookupCare(req, res) {
  const { plant } = await readBody(req);
  if (!plant) return sendJSON(res, 400, { error: "plant name required" });

  const prompt = `You are an expert horticulturist. Write a complete care guide for "${plant}".
Return ONLY a valid JSON object:
{
  "planting": {
    "when": "best time of year to plant with months",
    "how": "step by step planting instructions in 3-5 sentences",
    "tip": "one key planting tip most people miss"
  },
  "watering": {
    "frequency": "how often e.g. twice a week in summer",
    "method": "best watering method",
    "signs": "signs of overwatering and underwatering"
  },
  "feeding": {
    "fertilizer": "what type of fertilizer to use",
    "schedule": "when and how often to feed",
    "tip": "one feeding tip"
  },
  "pruning": {
    "when": "best time to prune",
    "how": "how to prune — what to cut, how much, tools",
    "tip": "one pruning tip"
  },
  "propagation": [
    {"method": "e.g. Division", "difficulty": "Easy", "season": "best season", "steps": "2-3 sentence how-to"},
    {"method": "e.g. Stem cuttings", "difficulty": "Moderate", "season": "best season", "steps": "2-3 sentence how-to"}
  ],
  "pests_diseases": [
    {"name": "pest or disease name", "signs": "what to look for", "treatment": "how to treat"},
    {"name": "another pest", "signs": "signs", "treatment": "treatment"}
  ],
  "seasonal_care": {
    "spring": "what to do in spring",
    "summer": "what to do in summer",
    "fall": "what to do in fall",
    "winter": "what to do in winter"
  }
}
difficulty: Easy/Moderate/Hard.`;

  const text = await ai(prompt, 2000);
  let care;
  try {
    care = parseJSON(text, "object");
  } catch(e) {
    const clean = text.replace(/```json|```/gi, "").trim();
    const start = clean.indexOf("{");
    if (start === -1) throw new Error("Could not parse care guide");
    let partial = clean.slice(start);
    let opens = 0, closes = 0;
    for (const ch of partial) { if (ch === "{") opens++; if (ch === "}") closes++; }
    partial += "}".repeat(Math.max(0, opens - closes));
    care = JSON.parse(partial);
  }
  sendJSON(res, 200, { care });
}

async function handleIdentifyPlant(req, res) {
  const { image, mimeType, uid } = await readBody(req, 10 * 1024 * 1024);
  if (!image) return sendJSON(res, 400, { error: "image is required" });

  const isPro = uid ? await dbIsProUser(uid) : false;
  if (!isPro) {
    const { allowed, used, limit } = await dbCheckLimit(uid || 'anonymous', 'identify');
    if (!allowed) {
      return sendJSON(res, 402, {
        error: "free_limit_reached",
        feature: "identify",
        message: `You've used all ${limit} free plant identifications this week. Upgrade to Pro for unlimited access.`,
        used, limit,
      });
    }
  }

  const prompt = `You are an expert botanist with decades of experience identifying plants from photographs. Carefully examine every detail of this image — leaf shape, leaf margins, venation pattern, stem structure, flower form, color, texture, growth habit, and any other visible characteristics.

Be precise and specific. If you can identify the plant to species level, do so. If you can only identify to genus, say so clearly.

Return ONLY a valid JSON object:
{
  "identified": true,
  "common_name": "Common Name",
  "scientific_name": "Genus species",
  "family": "Plant family",
  "confidence": "high",
  "confidence_reason": "brief explanation of what visual features confirm the ID",
  "description": "2-3 sentences about this plant",
  "care": {"sun": "requirements", "water": "needs", "soil": "preference", "hardiness": "USDA zones"},
  "mature_height": "e.g. 3-5 ft",
  "mature_spread": "e.g. 2-4 ft",
  "growth_rate": "slow/moderate/fast",
  "lifespan": "annual/perennial/biennial",
  "notes": "special characteristics or warnings",
  "edible": false,
  "toxic_to_pets": false,
  "similar_species": "any plants this could be confused with"
}
If you cannot identify with reasonable confidence: {"identified": false, "reason": "what you can see but why ID is uncertain"}
confidence must be high, medium, or low.`;

  const messages = [{
    role: "user",
    content: [
      { type: "image", source: { type: "base64", media_type: mimeType || "image/jpeg", data: image } },
      { type: "text", text: prompt },
    ],
  }];

  // Use Sonnet for vision — significantly better plant ID accuracy than Haiku
  const VISION_MODEL = process.env.VISION_MODEL || "claude-sonnet-4-6";
  const text = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: VISION_MODEL, max_tokens: 1200, messages });
    const req2 = https.request({
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
          const p = JSON.parse(data);
          if (p.error) return reject(new Error(p.error.message));
          resolve((p.content || []).map(b => b.text || "").join(""));
        } catch (e) { reject(e); }
      });
    });
    req2.on("error", reject);
    req2.write(body);
    req2.end();
  });

  const plant = parseJSON(text, "object");
  sendJSON(res, 200, { plant });
}

async function handleShoppingList(req, res) {
  const p = await readBody(req);

  const isPro = p.uid ? await dbIsProUser(p.uid) : false;
  if (!isPro) {
    return sendJSON(res, 402, {
      error: "free_limit_reached",
      feature: "shopping",
      message: "The shopping list is a Pro feature. Upgrade to BloomWise Pro for unlimited access.",
      limit: 0,
    });
  }
  const plantNames = (p.plants || []).map(pl => pl.name).filter(Boolean).join(", ");

  const prompt = `You are an expert horticulturist. Generate a practical shopping list for this garden. Return ONLY a valid JSON object.

Location: ${p.location || "Not specified"} | Zone: ${p.zone || "unknown"} | Sun: ${p.sun || "not specified"}
Soil: ${p.soil || "not specified"} | Water: ${p.water || "not specified"} | Style: ${p.style || "not specified"}
Priorities: ${p.priorities || "none"} | Notes: ${p.notes || "none"}
Plants: ${plantNames || "not specified"}

{
  "intro": "1-2 sentence summary",
  "categories": [
    {"name": "Plants", "icon": "🌱", "items": [{"name": "item", "detail": "quantity/spec", "tip": "buying tip", "priority": "essential"}]},
    {"name": "Soil & Amendments", "icon": "🪱", "items": [...]},
    {"name": "Tools", "icon": "🛠️", "items": [...]},
    {"name": "Extras", "icon": "✨", "items": [...]}
  ]
}
priority: "essential" or "optional". 3-6 items per category.`;

  const text = await ai(prompt, 2000);
  const list = parseJSON(text, "object");
  sendJSON(res, 200, { list });
}

async function handlePhotos(req, res) {
  const { name, scientific } = await readBody(req);
  if (!name) return sendJSON(res, 400, { error: "name is required" });

  if (process.env.PERENUAL_API_KEY) {
    try {
      for (const q of [scientific, name].filter(Boolean)) {
        const resp = await httpGet(
          `https://perenual.com/api/species-list?key=${process.env.PERENUAL_API_KEY}&q=${encodeURIComponent(q)}&per_page=3`
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
        `https://climate-api.open-meteo.com/v1/climate?latitude=${latitude}&longitude=${longitude}&start_date=1991-01-01&end_date=2020-12-31&models=EC_Earth3P_HR&daily=temperature_2m_min&timezone=auto`,
        5000  // 5s timeout — fall back to latitude estimate if slow
      );
      if (climate.daily?.temperature_2m_min) {
        const temps = climate.daily.temperature_2m_min.filter(t => t !== null);
        if (temps.length > 0) minTempC = Math.min(...temps);
      }
    } catch (e) { /* fall through to latitude estimate */ }

    if (minTempC === null) {
      const a = Math.abs(latitude);
      minTempC = a < 10 ? 15 : a < 20 ? 5 : a < 30 ? -2 : a < 40 ? -10 : a < 50 ? -20 : a < 60 ? -32 : -45;
    }

    const F = minTempC * 9 / 5 + 32;
    const RHS = new Set(["GB","IE","NL","BE","FR","DE","AT","CH","DK","NO","SE","FI","IS","PT","ES","IT","PL","CZ","SK","HU","RO","HR","SI","BG","GR","TR"]);
    const AU  = new Set(["AU","NZ"]);

    let zoneLabel, system;
    if (AU.has(country)) {
      system = "Australian";
      zoneLabel = minTempC >= 18 ? "Zone 1 — Tropical" : minTempC >= 10 ? "Zone 2 — Subtropical" :
                  minTempC >= 2  ? "Zone 3 — Warm temperate" : minTempC >= -5 ? "Zone 4 — Cool temperate" :
                  minTempC >= -12 ? "Zone 5 — Cold temperate" : minTempC >= -20 ? "Zone 6 — Alpine" : "Zone 7 — Sub-alpine";
    } else if (RHS.has(country)) {
      system = "RHS";
      zoneLabel = minTempC >= 15 ? "H1a — Heated glasshouse" : minTempC >= 10 ? "H1b — Warm glasshouse" :
                  minTempC >= 5  ? "H1c — Cool glasshouse" : minTempC >= 0  ? "H2 — Half hardy" :
                  minTempC >= -5 ? "H3 — Hardy in sheltered spots" : minTempC >= -10 ? "H4 — Hardy through most of UK" :
                  minTempC >= -15 ? "H5 — Hardy in most places" : minTempC >= -20 ? "H6 — Hardy in all of UK" : "H7 — Very hardy";
    } else {
      system = "USDA";
      zoneLabel = F < -60 ? "Zone 1" : F < -50 ? "Zone 2" : F < -40 ? "Zone 3" : F < -30 ? "Zone 4" :
                  F < -20 ? "Zone 5" : F < -10 ? "Zone 6" : F < 0  ? "Zone 7" : F < 10 ? "Zone 8" :
                  F < 20  ? "Zone 9" : F < 30  ? "Zone 10" : F < 40 ? "Zone 11" : "Zone 12";
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

  const KEY = process.env.GOOGLE_PLACES_API_KEY;
  if (!KEY) return sendJSON(res, 200, { nurseries: [], error: "Google Places not configured" });

  try {
    const geo = await httpGet(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${KEY}`
    );
    if (!geo.results?.length) return sendJSON(res, 200, { nurseries: [], error: "Location not found" });

    const { lat, lng } = geo.results[0].geometry.location;
    const places = await httpGet(
      `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=40000&keyword=plant+nursery&type=store&key=${KEY}`
    );

    const nurseries = (places.results || []).slice(0, 10).map(p => ({
      name: p.name, address: p.vicinity,
      rating: p.rating || null, reviews: p.user_ratings_total || 0,
      open: p.opening_hours?.open_now ?? null,
      lat: p.geometry.location.lat, lng: p.geometry.location.lng,
    }));

    sendJSON(res, 200, { nurseries, center: { lat, lng } });
  } catch (e) {
    console.warn("Nursery error:", e.message);
    sendJSON(res, 200, { nurseries: [], error: e.message });
  }
}

async function handleGeocode(req, res) {
  const { location } = await readBody(req);
  if (!location) return sendJSON(res, 400, { error: "location is required" });

  const KEY = process.env.GOOGLE_PLACES_API_KEY;

  // Try Google Geocoding first (handles full street addresses)
  if (KEY) {
    try {
      const geo = await httpGet(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${KEY}`
      );
      if (geo.results?.length) {
        const { lat, lng } = geo.results[0].geometry.location;
        const displayName  = geo.results[0].formatted_address;
        return sendJSON(res, 200, { found: true, latitude: lat, longitude: lng, displayName });
      }
    } catch(e) { console.warn("Google geocode error:", e.message); }
  }

  // Fall back to Open-Meteo (city names only, no API key needed)
  try {
    const geo = await httpGet(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`
    );
    if (geo.results?.length) {
      const { latitude, longitude, name, admin1, country_code } = geo.results[0];
      const displayName = [name, admin1, country_code].filter(Boolean).join(", ");
      return sendJSON(res, 200, { found: true, latitude, longitude, displayName });
    }
  } catch(e) { console.warn("Open-Meteo geocode error:", e.message); }

  sendJSON(res, 200, { found: false });
}

async function handleMapImage(req, res) {
  const { lat, lng, zoom, w, h } = await readBody(req);
  const KEY = process.env.GOOGLE_STATIC_MAPS_KEY || process.env.GOOGLE_PLACES_API_KEY;

  if (!KEY) return sendJSON(res, 200, { url: null, error: "No Maps API key configured" });

  const width  = Math.min(Math.round(w) || 640, 640);
  const height = Math.min(Math.round(h) || 400, 640);

  const url = `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=${width}x${height}&maptype=satellite&key=${KEY}`;
  sendJSON(res, 200, { url });
}

async function handleGetGarden(req, res) {
  const { uid } = await readBody(req);
  if (!uid) return sendJSON(res, 400, { error: "uid required" });
  const plants = await dbGetGarden(uid);
  sendJSON(res, 200, { plants });
}

async function handleSaveGarden(req, res) {
  const { uid, plants } = await readBody(req, 5 * 1024 * 1024);
  if (!uid) return sendJSON(res, 400, { error: "uid required" });

  const isPro = await dbIsProUser(uid);
  const MAX_FREE_GARDEN = 6;

  if (!isPro && plants && plants.length > MAX_FREE_GARDEN) {
    return sendJSON(res, 402, {
      error: "free_limit_reached",
      feature: "garden",
      message: `Free accounts can save up to ${MAX_FREE_GARDEN} plants. Upgrade to Pro for unlimited garden size.`,
      limit: MAX_FREE_GARDEN,
    });
  }

  // Ensure plants is always a valid array before saving
  const safePlants = Array.isArray(plants) ? plants : [];
  await dbSaveGarden(uid, safePlants);
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
    mode: "payment",                          // one-time, not subscription
    "line_items[0][price]": STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    success_url: `${STRIPE_SUCCESS_URL}&uid=${uid}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: STRIPE_CANCEL_URL,
    "metadata[uid]": uid,
    "payment_intent_data[metadata][uid]": uid, // one-time payment metadata
  });

  if (session.error) return sendJSON(res, 400, { error: session.error.message });
  sendJSON(res, 200, { url: session.url });
}

async function handleVerifyStripeSession(req, res) {
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
  if (!STRIPE_WEBHOOK_SEC) return sendJSON(res, 400, { error: "Webhook secret not configured" });
  const rawBody = await readBodyRaw(req);
  const sig = req.headers["stripe-signature"] || "";

  try {
    const parts = sig.split(",");
    const ts = parts.find(p => p.startsWith("t="))?.slice(2);
    const v1 = parts.find(p => p.startsWith("v1="))?.slice(3);
    const expected = crypto.createHmac("sha256", STRIPE_WEBHOOK_SEC)
      .update(`${ts}.${rawBody}`).digest("hex");
    if (expected !== v1) return sendJSON(res, 400, { error: "Invalid signature" });
  } catch (e) {
    return sendJSON(res, 400, { error: "Signature verification failed" });
  }

  const event = JSON.parse(rawBody.toString());

  // One-time payment completed
  if (event.type === "checkout.session.completed") {
    const uid = event.data.object.metadata?.uid;
    if (uid) await dbSetPro(uid, true, event.data.object.customer);
  }

  // Also handle payment_intent for redundancy
  if (event.type === "payment_intent.succeeded") {
    const uid = event.data.object.metadata?.uid;
    if (uid) await dbSetPro(uid, true);
  }
  sendJSON(res, 200, { received: true });
}

// ── Admin ─────────────────────────────────────────────────
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const adminTokens    = new Set(); // in-memory admin sessions (short lived)

async function handleAdminLogin(req, res) {
  const { email, password } = await readBody(req);
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD)
    return sendJSON(res, 500, { error: "Admin credentials not configured in Railway env vars (ADMIN_EMAIL, ADMIN_PASSWORD)" });
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD)
    return sendJSON(res, 401, { error: "Invalid admin credentials" });
  const token = crypto.randomBytes(32).toString("hex");
  adminTokens.add(token);
  setTimeout(() => adminTokens.delete(token), 8 * 60 * 60 * 1000); // 8hr expiry
  sendJSON(res, 200, { ok: true, token });
}

function requireAdmin(req) {
  const token = req.headers["x-admin-token"] || "";
  return adminTokens.has(token);
}

async function handleAdminStats(req, res) {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  if (!db) return sendJSON(res, 500, { error: "No database" });

  const [
    totalAccounts,
    proUsers,
    recentSignups,
    usageThisWeek,
    gardenStats,
    topUsers,
  ] = await Promise.all([
    db.query("SELECT COUNT(*) FROM accounts"),
    db.query("SELECT COUNT(*) FROM users WHERE is_pro = TRUE"),
    db.query(`SELECT email, name, created_at FROM accounts ORDER BY created_at DESC LIMIT 20`),
    db.query(`SELECT feature, SUM(rec_count) as total FROM usage
              WHERE usage_date >= date_trunc('week', CURRENT_DATE)
              GROUP BY feature ORDER BY total DESC`),
    db.query(`SELECT COUNT(*) as gardens, AVG(jsonb_array_length(plants)) as avg_plants
              FROM gardens WHERE jsonb_array_length(plants) > 0`),
    db.query(`SELECT a.email, a.name, a.created_at,
                     COALESCE(u.is_pro, FALSE) as is_pro,
                     COALESCE(SUM(us.rec_count), 0) as total_usage
              FROM accounts a
              LEFT JOIN users u ON u.uid = a.email
              LEFT JOIN usage us ON us.uid = a.email
              GROUP BY a.email, a.name, a.created_at, u.is_pro
              ORDER BY a.created_at DESC LIMIT 50`),
  ]);

  sendJSON(res, 200, {
    totals: {
      accounts: parseInt(totalAccounts.rows[0].count),
      pro: parseInt(proUsers.rows[0].count),
      free: parseInt(totalAccounts.rows[0].count) - parseInt(proUsers.rows[0].count),
      gardens: parseInt(gardenStats.rows[0]?.gardens || 0),
      avg_plants: parseFloat(gardenStats.rows[0]?.avg_plants || 0).toFixed(1),
    },
    usage_this_week: usageThisWeek.rows,
    users: topUsers.rows,
  });
}

async function handleAdminTogglePro(req, res) {
  if (!requireAdmin(req)) return sendJSON(res, 401, { error: "Unauthorized" });
  const { email, is_pro } = await readBody(req);
  if (!email) return sendJSON(res, 400, { error: "email required" });
  await db.query(
    `INSERT INTO users (uid, is_pro) VALUES ($1, $2)
     ON CONFLICT (uid) DO UPDATE SET is_pro = $2`,
    [email, !!is_pro]
  );
  sendJSON(res, 200, { ok: true, email, is_pro: !!is_pro });
}



function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

async function createSession(email, uid) {
  const token    = generateSessionToken();
  const expires  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days
  if (db) {
    await db.query(
      "INSERT INTO sessions (token, email, uid, expires_at) VALUES ($1,$2,$3,$4)",
      [token, email, uid, expires]
    );
  }
  return token;
}

async function handleSignup(req, res) {
  const { email, password, name, uid } = await readBody(req);

  if (!email || !email.includes("@"))
    return sendJSON(res, 400, { error: "Valid email required" });
  if (!password || password.length < 8)
    return sendJSON(res, 400, { error: "Password must be at least 8 characters" });

  const cleanEmail = email.toLowerCase().trim();

  if (db) {
    const existing = await db.query("SELECT id FROM accounts WHERE email=$1", [cleanEmail]);
    if (existing.rows.length)
      return sendJSON(res, 409, { error: "An account with this email already exists" });
  }

  const hash = await bcrypt.hash(password, 12);

  let accountUid = uid || cleanEmail;
  if (db) {
    const r = await db.query(
      "INSERT INTO accounts (email, name, password_hash, uid) VALUES ($1,$2,$3,$4) RETURNING *",
      [cleanEmail, name || cleanEmail.split("@")[0], hash, accountUid]
    );
    accountUid = r.rows[0].uid || cleanEmail;
  }

  // Migrate anonymous garden if they had one
  if (uid && uid !== cleanEmail && db) {
    const anonGarden = await db.query("SELECT plants FROM gardens WHERE uid=$1", [uid]);
    if (anonGarden.rows.length) {
      await db.query(
        "INSERT INTO gardens (uid, plants) VALUES ($1,$2::jsonb) ON CONFLICT (uid) DO NOTHING",
        [cleanEmail, JSON.stringify(anonGarden.rows[0].plants || [])]
      );
    }
    // Migrate pro status
    const anonPro = await db.query("SELECT is_pro FROM users WHERE uid=$1", [uid]);
    if (anonPro.rows[0]?.is_pro) {
      await db.query(
        "INSERT INTO users (uid, is_pro) VALUES ($1,TRUE) ON CONFLICT (uid) DO UPDATE SET is_pro=TRUE",
        [cleanEmail]
      );
    }
    // Migrate usage so they keep their remaining weekly allowance
    await db.query(
      `INSERT INTO usage (uid, usage_date, rec_count, feature)
       SELECT $1, usage_date, rec_count, feature FROM usage WHERE uid=$2
       ON CONFLICT (uid, usage_date, feature) DO UPDATE
       SET rec_count = GREATEST(usage.rec_count, EXCLUDED.rec_count)`,
      [cleanEmail, uid]
    );
  }

  const token = await createSession(cleanEmail, cleanEmail);
  sendJSON(res, 200, {
    ok: true,
    token,
    email: cleanEmail,
    uid: cleanEmail,
    name: name || cleanEmail.split("@")[0],
  });
}

async function handleLogin(req, res) {
  const { email, password } = await readBody(req);

  if (!email || !password)
    return sendJSON(res, 400, { error: "Email and password required" });

  const cleanEmail = email.toLowerCase().trim();

  if (!db) return sendJSON(res, 500, { error: "Database not configured" });

  const r = await db.query("SELECT * FROM accounts WHERE email=$1", [cleanEmail]);
  if (!r.rows.length)
    return sendJSON(res, 401, { error: "No account found with this email" });

  const account = r.rows[0];
  if (!account.password_hash)
    return sendJSON(res, 401, { error: "This account uses a different sign-in method" });

  const valid = await bcrypt.compare(password, account.password_hash);
  if (!valid)
    return sendJSON(res, 401, { error: "Incorrect password" });

  const token = await createSession(cleanEmail, cleanEmail);
  sendJSON(res, 200, {
    ok: true,
    token,
    email: cleanEmail,
    uid: cleanEmail,
    name: account.name || cleanEmail.split("@")[0],
  });
}

async function handleVerifySession(req, res) {
  const { token } = await readBody(req);
  if (!token) return sendJSON(res, 400, { error: "Token required" });
  if (!db)    return sendJSON(res, 500, { error: "Database not configured" });

  const r = await db.query(
    "SELECT * FROM sessions WHERE token=$1 AND expires_at > NOW()",
    [token]
  );
  if (!r.rows.length) return sendJSON(res, 401, { error: "Session expired — please sign in again" });

  const { email, uid } = r.rows[0];
  const acct = await db.query("SELECT name FROM accounts WHERE email=$1", [email]);
  const name = acct.rows[0]?.name || email.split("@")[0];

  sendJSON(res, 200, { ok: true, email, uid, name });
}

async function handleSignout(req, res) {
  const { token } = await readBody(req);
  if (token && db) {
    await db.query("DELETE FROM sessions WHERE token=$1", [token]);
  }
  sendJSON(res, 200, { ok: true });
}

// Keep magic link send for optional future use — currently unused
async function handleSendMagicLink(req, res) {
  sendJSON(res, 200, { ok: true, message: "Magic links not active — use email/password login" });
}

// ══════════════════════════════════════════════════════════
// MAIN SERVER
// ══════════════════════════════════════════════════════════

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0].replace(/\/+$/, "") || "/";

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

  // GET
  if (req.method === "GET") {
    if (url === "/health") return sendJSON(res, 200, { status: "ok", model: MODEL, db: !!db });
    if (url === "/admin" || url === "/admin/") {
      const adminPath = path.join(__dirname, "admin.html");
      return fs.readFile(adminPath, (err, data) => {
        if (err) { res.writeHead(404); res.end("Admin dashboard not found"); return; }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(data);
      });
    }
    return sendHTML(res);
  }

  // POST
  if (req.method === "POST") {

    // Stripe webhook — raw body only
    if (url === "/stripe-webhook") {
      try { await handleStripeWebhook(req, res); }
      catch (e) { sendJSON(res, 500, { error: e.message }); }
      return;
    }

    // Free routes — no Anthropic needed
    const FREE = {
      "/admin/login":         handleAdminLogin,
      "/admin/stats":         handleAdminStats,
      "/admin/toggle-pro":    handleAdminTogglePro,
      "/geocode":             handleGeocode,
      "/photos":              handlePhotos,
      "/zone":                handleZone,
      "/check-pro":           handleCheckPro,
      "/create-checkout":     handleCreateCheckout,
      "/verify-session":      handleVerifyStripeSession,
      "/garden/get":          handleGetGarden,
      "/garden/save":         handleSaveGarden,
      "/shopping-list":       handleShoppingList,
      "/nurseries":           handleNurseries,
      "/auth/signup":         handleSignup,
      "/auth/login":          handleLogin,
      "/auth/verify-session": handleVerifySession,
      "/auth/signout":        handleSignout,
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
      return sendJSON(res, 500, { error: "ANTHROPIC_API_KEY not set in Railway environment variables" });
    }
    if (isRateLimited(getIP(req))) {
      return sendJSON(res, 429, { error: "Too many requests — please wait a moment and try again" });
    }

    const AI = {
      "/recommendations":   handleRecommendations,
      "/lookup":            handleLookup,
      "/lookup-care":       handleLookupCare,
      "/identify-plant":    handleIdentifyPlant,
      "/garden-advisor":    handleGardenAdvisor,
      "/planting-calendar": handlePlantingCalendar,
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
  ║   http://localhost:${PORT}                      ║
  ║                                              ║
  ║   Anthropic: ${ANTHROPIC_KEY  ? "✅" : "❌ ANTHROPIC_API_KEY missing"}                    ║
  ║   Stripe:    ${STRIPE_KEY     ? "✅" : "⚠️  not set"}                         ║
  ║   Database:  ${process.env.DATABASE_URL ? "✅ PostgreSQL" : "⚠️  in-memory"}              ║
  ║   Perenual:  ${process.env.PERENUAL_API_KEY ? "✅" : "⚠️  not set"}                    ║
  ║   Places:    ${process.env.GOOGLE_PLACES_API_KEY ? "✅" : "⚠️  not set"}                    ║
  ║   Free tier: ${FREE_RECS_PER_DAY} recs/day                       ║
  ╚══════════════════════════════════════════════╝`);
    });
  })
  .catch(err => {
    console.error("DB connection failed:", err.message, "— starting without database");
    server.listen(PORT);
  });
