// BloomWise — Full Stack Server
// Serves the frontend (index.html) AND the API from one Railway deployment
//
// Local dev:
//   ANTHROPIC_API_KEY=sk-ant-... node server.js
//   Then open http://localhost:3000
//
// Deploy to Railway:
//   1. Push this whole folder to GitHub
//   2. New Railway project → Deploy from GitHub
//   3. Set environment variable: ANTHROPIC_API_KEY=sk-ant-...
//   4. Done — Railway gives you a public URL

const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const PORT          = process.env.PORT || 3000;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL         = process.env.MODEL || "claude-haiku-4-5-20251001";

// ---------- Rate limiter ----------
const WINDOW_MS    = 60 * 1000;
const MAX_REQUESTS = 20;
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
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function sendHTML(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 20000) reject(new Error("Request too large"));
    });
    req.on("end", () => {
      try   { resolve(JSON.parse(body)); }
      catch { reject(new Error("Invalid JSON body")); }
    });
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

// ---------- API route handlers ----------

async function handleRecommendations(req, res) {
  const p = await readBody(req);

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
  sendJSON(res, 200, { plants });
}

async function handleLookup(req, res) {
  const { plant, site } = await readBody(req);

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
  sendJSON(res, 200, { result });
}

async function handleClaude(req, res) {
  const { prompt, max } = await readBody(req);
  if (!prompt) return sendJSON(res, 400, { error: "prompt is required" });
  const text = await callAnthropic(prompt, max || 1800);
  sendJSON(res, 200, { text });
}

// ---------- Main server ----------

// Path to your frontend file — must be in the same folder as server.js
const FRONTEND_PATH = path.join(__dirname, "index.html");

const server = http.createServer(async (req, res) => {

  // Strip query strings for routing
  const url = req.url.split("?")[0];

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":  "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    });
    return res.end();
  }

  // ── Frontend routes (GET) ──────────────────────────────
  if (req.method === "GET") {
    if (url === "/" || url === "/index.html") {
      return sendHTML(res, FRONTEND_PATH);
    }
    if (url === "/health") {
      return sendJSON(res, 200, { status: "ok", model: MODEL });
    }
    // Any other GET → serve index.html (handles browser refresh on any path)
    return sendHTML(res, FRONTEND_PATH);
  }

  // ── API routes (POST) ─────────────────────────────────
  if (req.method === "POST") {
    if (!ANTHROPIC_KEY) {
      return sendJSON(res, 500, { error: "ANTHROPIC_API_KEY not set — add it in Railway environment variables" });
    }

    const ip = getIP(req);
    if (isRateLimited(ip)) {
      return sendJSON(res, 429, { error: "Too many requests — please wait a moment and try again" });
    }

    try {
      if      (url === "/recommendations") await handleRecommendations(req, res);
      else if (url === "/lookup")          await handleLookup(req, res);
      else if (url === "/claude")          await handleClaude(req, res);
      else sendJSON(res, 404, { error: "API route not found" });
    } catch (e) {
      console.error(`[${new Date().toISOString()}] Error on ${url}:`, e.message);
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  // Anything else
  sendJSON(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║         🌸  BloomWise Server                 ║
  ║                                              ║
  ║   Frontend:  http://localhost:${PORT}           ║
  ║                                              ║
  ║   API:                                       ║
  ║     POST  /recommendations                   ║
  ║     POST  /lookup                            ║
  ║     POST  /claude                            ║
  ║     GET   /health                            ║
  ║                                              ║
  ║   API key: ${ANTHROPIC_KEY ? "✅ configured" : "❌ ANTHROPIC_API_KEY not set"}          ║
  ╚══════════════════════════════════════════════╝
  `);
});
