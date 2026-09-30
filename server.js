// Spinco Card Bot - WhatsApp webhook server
// Receives business card photos on WhatsApp, reads the details with AI,
// replies below the photo, and saves everything against the sender's number.

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Load .env from this folder (works on any Node version and under pm2)
(function loadEnv() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const key = line.slice(0, line.indexOf("=")).trim();
    let value = line.slice(line.indexOf("=") + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
})();

if (typeof fetch !== "function") {
  console.error(`Node.js ${process.version} is too old. Please use Node 18 or newer.`);
  process.exit(1);
}

const {
  PORT = 3000,
  VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  APP_SECRET,
  AI_PROVIDER = "gemini", // gemini (free) | ollama (free, local) | openai (paid) | claude (paid)
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4.1-mini",
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-flash-latest",
  OLLAMA_URL = "http://localhost:11434",
  OLLAMA_MODEL = "qwen2.5vl",
  ANTHROPIC_API_KEY,
  AI_MODEL = "claude-haiku-4-5-20251001",
  GRAPH_VERSION = "v25.0",
  DASHBOARD_PASSWORD,
} = process.env;

// Don't crash on missing settings (that causes "Bad Gateway" on hosting).
// Start anyway and list what's missing on the home page and in the logs.
const required = { VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID };
if (AI_PROVIDER === "gemini") required.GEMINI_API_KEY = GEMINI_API_KEY;
if (AI_PROVIDER === "claude") required.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY;
if (AI_PROVIDER === "openai") required.OPENAI_API_KEY = OPENAI_API_KEY;
const missing = Object.keys(required).filter((k) => !required[k]);
if (missing.length) console.error(`⚠️  Missing settings: ${missing.join(", ")} (add them to .env or the hosting Environment Variables)`);

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const IMAGE_DIR = path.join(DATA_DIR, "images");
const DB_FILE = path.join(DATA_DIR, "cards.json");
let storageError = null;
try {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]");
} catch (err) {
  storageError = `Cannot write to ${DATA_DIR}: ${err.message}`;
  console.error("⚠️  " + storageError);
}

// ---------- simple JSON "database" (swap for Postgres/Mongo later) ----------
function loadCards() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return [];
  }
}
// Duplicate rule: same email = same card.
// If the card has no email, fall back to the same phone number (last 10 digits).
const cleanEmail = (e) => String(e || "").trim().toLowerCase();
const cleanPhone = (p) => String(p || "").replace(/\D/g, "").slice(-10);
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

function findDuplicate(details) {
  const cards = loadCards();
  const emails = asList(details.emails).map(cleanEmail).filter(Boolean);
  if (emails.length) {
    for (const card of cards) {
      const hit = asList(card.emails).map(cleanEmail).find((e) => emails.includes(e));
      if (hit) return { card, match: `✉️ ${hit}` };
    }
    return null;
  }
  const phones = asList(details.phones).map(cleanPhone).filter((p) => p.length === 10);
  for (const card of cards) {
    const hit = asList(card.phones).find((p) => phones.includes(cleanPhone(p)));
    if (hit) return { card, match: `📞 ${hit}` };
  }
  return null;
}

function saveCard(card) {
  const cards = loadCards();
  cards.unshift(card);
  fs.writeFileSync(DB_FILE, JSON.stringify(cards, null, 2));
}

// ---------- app ----------
const app = express();
// keep the raw body so we can verify Meta's signature
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));

// 1) Meta calls this once to verify the webhook URL
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified by Meta");
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// 2) Meta sends every incoming message here
const seen = new Set(); // Meta may retry; ignore duplicates
app.post("/webhook", (req, res) => {
  if (APP_SECRET && !validSignature(req)) {
    console.warn("Rejected request with bad signature");
    return res.sendStatus(401);
  }
  res.sendStatus(200); // reply to Meta immediately, work afterwards

  const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages || [];
  for (const msg of messages) {
    if (seen.has(msg.id)) continue;
    seen.add(msg.id);
    handleMessage(msg).catch((err) => console.error("Error handling message:", err.message));
  }
});

function validSignature(req) {
  const header = req.get("x-hub-signature-256") || "";
  const expected = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody || "").digest("hex");
  return header.length === expected.length && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

async function handleMessage(msg) {
  const from = msg.from; // sender's WhatsApp number, e.g. 9179XXXXXXXX
  console.log(`Message from ${from}: type=${msg.type}`);

  if (msg.type !== "image") {
    return sendText(from, "👋 Hi! Please send a clear photo of a business card and I'll read the details for you.", msg.id);
  }

  await sendText(from, "📇 Got it! Reading the card...", msg.id);

  let buffer, mimeType, details;
  try {
    // download the photo from WhatsApp
    ({ buffer, mimeType } = await downloadMedia(msg.image.id));
  } catch (err) {
    console.error(`❌ STEP 1 (download photo from WhatsApp) failed: ${err.message}`);
    return sendText(from, "⚠️ Sorry, I couldn't download the photo. Please try again in a minute.", msg.id);
  }
  try {
    // read the card with AI
    details = await extractCardDetails(buffer, mimeType);
  } catch (err) {
    console.error(`❌ STEP 2 (AI reading the card, provider=${AI_PROVIDER}) failed: ${err.message}`);
    return sendText(from, "⚠️ Sorry, I couldn't read the card right now. Please try again in a minute.", msg.id);
  }

  if (!details || details.not_a_card) {
    return sendText(from, "🤔 I couldn't find a business card in that photo. Please send a clearer, straight photo of the card.", msg.id);
  }

  // duplicate check: same email already saved -> don't save again
  const existing = findDuplicate(details);
  if (existing) {
    console.log(`Duplicate card from ${from}: ${existing.match} already saved`);
    const when = new Date(existing.card.created_at).toLocaleDateString("en-IN", { dateStyle: "medium" });
    return sendText(
      from,
      `⚠️ *This card details already fetched*\n\n` +
        `${existing.card.name ? `👤 ${existing.card.name}\n` : ""}` +
        `${existing.match}\n` +
        `📅 Saved on ${when}\n\n` +
        `Not saved again.`,
      msg.id
    );
  }

  // new card -> keep the photo and save against the sender's registered number
  const ext = mimeType.includes("png") ? "png" : "jpg";
  const fileName = `${Date.now()}_${from}.${ext}`;
  try {
    fs.writeFileSync(path.join(IMAGE_DIR, fileName), buffer);
    saveCard({
      id: msg.id,
      sender_number: from,
      image_file: fileName,
      ...details,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`❌ STEP 3 (saving to ${DATA_DIR}) failed: ${err.message}`);
    await sendText(from, formatDetails(details).replace("Saved to your CRM ✔️", "⚠️ Could not save to CRM right now."), msg.id);
    return;
  }

  // reply below the image (quoted reply)
  await sendText(from, formatDetails(details), msg.id);
  console.log(`Saved card for ${from}: ${details.name || "(no name)"}`);
}

// ---------- WhatsApp API helpers ----------
async function downloadMedia(mediaId) {
  const auth = { Authorization: `Bearer ${WHATSAPP_TOKEN}` };
  const metaRes = await fetch(`${GRAPH}/${mediaId}`, { headers: auth });
  if (!metaRes.ok) throw new Error(`Media lookup failed: ${await metaRes.text()}`);
  const meta = await metaRes.json();

  const fileRes = await fetch(meta.url, { headers: auth });
  if (!fileRes.ok) throw new Error(`Media download failed: ${fileRes.status}`);
  return { buffer: Buffer.from(await fileRes.arrayBuffer()), mimeType: meta.mime_type || "image/jpeg" };
}

async function sendText(to, body, replyToMessageId) {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  };
  if (replyToMessageId) payload.context = { message_id: replyToMessageId };

  const res = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error("Send failed:", await res.text());
}

// ---------- AI card reader ----------
const PROMPT = `You are reading a photo of a business card. Extract the details and reply with ONLY a JSON object, no other text:
{"name": "", "designation": "", "company": "", "phones": [], "emails": [], "website": "", "address": "", "not_a_card": false}
Use "" or [] for anything not on the card. If the photo is not a business card, set "not_a_card": true.`;

function parseJson(text) {
  const json = (text || "").match(/\{[\s\S]*\}/);
  return json ? JSON.parse(json[0]) : null;
}

async function extractCardDetails(buffer, mimeType) {
  if (AI_PROVIDER === "gemini") return extractWithGemini(buffer, mimeType);
  if (AI_PROVIDER === "ollama") return extractWithOllama(buffer);
  if (AI_PROVIDER === "openai") return extractWithOpenAI(buffer, mimeType);
  return extractWithClaude(buffer, mimeType);
}

// FREE option 1: Google Gemini (free tier from aistudio.google.com)
async function extractWithGemini(buffer, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } },
            { text: PROMPT },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json", temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini request failed: ${await res.text()}`);
  const data = await res.json();
  return parseJson(data.candidates?.[0]?.content?.parts?.map((p) => p.text).join(""));
}

// FREE option 2: Ollama running on your own computer (no internet AI, no cost)
async function extractWithOllama(buffer) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      stream: false,
      format: "json",
      options: { temperature: 0 },
      messages: [{ role: "user", content: PROMPT, images: [buffer.toString("base64")] }],
    }),
  });
  if (!res.ok) throw new Error(`Ollama request failed: ${await res.text()}`);
  const data = await res.json();
  return parseJson(data.message?.content);
}

// Paid option: OpenAI / ChatGPT API (platform.openai.com)
async function extractWithOpenAI(buffer, mimeType) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT },
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${buffer.toString("base64")}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI request failed: ${await res.text()}`);
  const data = await res.json();
  return parseJson(data.choices?.[0]?.message?.content);
}

// Paid option: Claude (most accurate)
async function extractWithClaude(buffer, mimeType) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: 800,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: buffer.toString("base64") } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI request failed: ${await res.text()}`);
  const data = await res.json();
  return parseJson(data.content?.[0]?.text);
}

function formatDetails(d) {
  const lines = ["✅ *Business card details*", ""];
  if (d.name) lines.push(`👤 *Name:* ${d.name}`);
  if (d.designation) lines.push(`💼 *Designation:* ${d.designation}`);
  if (d.company) lines.push(`🏢 *Company:* ${d.company}`);
  if (d.phones?.length) lines.push(`📞 *Phone:* ${d.phones.join(", ")}`);
  if (d.emails?.length) lines.push(`✉️ *Email:* ${d.emails.join(", ")}`);
  if (d.website) lines.push(`🌐 *Website:* ${d.website}`);
  if (d.address) lines.push(`📍 *Address:* ${d.address}`);
  lines.push("", "Saved to your CRM ✔️");
  return lines.join("\n");
}

// ---------- CRM dashboard (password protected) ----------
// Login: username "admin", password = DASHBOARD_PASSWORD from .env
// If no password is set in .env, make one up and show it in the console at startup.
const DASH_PASS = (DASHBOARD_PASSWORD || "").trim() || crypto.randomBytes(4).toString("hex");
function requireLogin(req, res, next) {
  const [scheme, encoded] = (req.get("authorization") || "").split(" ");
  const decoded = Buffer.from(encoded || "", "base64").toString();
  const user = decoded.slice(0, decoded.indexOf(":"));
  const pass = decoded.slice(decoded.indexOf(":") + 1);
  if (scheme === "Basic" && user === "admin" && pass === DASH_PASS) return next();
  res.set("WWW-Authenticate", 'Basic realm="Spinco CRM"').status(401).send("Login required");
}

app.get("/dashboard", requireLogin, (_req, res) => res.sendFile(path.join(__dirname, "dashboard.html")));
app.get("/api/cards", requireLogin, (req, res) => {
  const { number } = req.query;
  const cards = loadCards();
  res.json(number ? cards.filter((c) => c.sender_number === number) : cards);
});
app.delete("/api/cards/:id", requireLogin, (req, res) => {
  const cards = loadCards();
  const card = cards.find((c) => c.id === req.params.id);
  if (!card) return res.sendStatus(404);
  fs.writeFileSync(DB_FILE, JSON.stringify(cards.filter((c) => c.id !== req.params.id), null, 2));
  fs.rmSync(path.join(IMAGE_DIR, path.basename(card.image_file)), { force: true });
  res.sendStatus(204);
});
app.use("/images", requireLogin, express.static(IMAGE_DIR));

app.get("/", (_req, res) => {
  const problems = [...missing.map((k) => `Missing setting: ${k}`), ...(storageError ? [storageError] : [])];
  res.type("text/plain").send(
    problems.length
      ? `Spinco Card Bot is running, but needs attention:\n\n- ${problems.join("\n- ")}`
      : "Spinco Card Bot is running ✅"
  );
});
app.get("/health", (_req, res) => res.json({ ok: true, missing, storageError }));

// Self-test (login required): checks WhatsApp token, AI key and storage in one go
app.get("/selftest", requireLogin, async (_req, res) => {
  const out = {};
  try {
    const r = await fetch(`${GRAPH}/${PHONE_NUMBER_ID}?fields=display_phone_number`, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
    const j = await r.json();
    out.whatsapp = r.ok ? `OK (${j.display_phone_number})` : `FAILED: ${j.error?.message || r.status}`;
  } catch (e) { out.whatsapp = `FAILED: ${e.message}`; }
  try {
    if (AI_PROVIDER === "openai") {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: OPENAI_MODEL, max_tokens: 5, messages: [{ role: "user", content: "Reply with OK" }] }),
      });
      const j = await r.json();
      out.ai = r.ok ? `OK (openai / ${OPENAI_MODEL})` : `FAILED: ${j.error?.message || r.status}`;
    } else {
      out.ai = `not tested for provider "${AI_PROVIDER}"`;
    }
  } catch (e) { out.ai = `FAILED: ${e.message}`; }
  try {
    const f = path.join(DATA_DIR, ".write-test");
    fs.writeFileSync(f, "ok"); fs.rmSync(f);
    out.storage = `OK (${DATA_DIR})`;
  } catch (e) { out.storage = `FAILED: ${e.message}`; }
  out.missing_settings = missing.length ? missing : "none";
  res.type("text/plain").send(Object.entries(out).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\n"));
});

process.on("unhandledRejection", (err) => console.error("Unhandled error:", err?.message || err));

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`CRM dashboard:  http://localhost:${PORT}/dashboard`);
  console.log(`Dashboard login -> username: admin   password: ${DASH_PASS}`);
  if (!DASHBOARD_PASSWORD) console.log("(Temporary password. Add DASHBOARD_PASSWORD=yourpassword to .env to keep a fixed one.)");
});
