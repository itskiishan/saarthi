// SaarThi backend server
// Features:
// - Multilingual intent recognition over curated FAQs (EN, HI, BN, TA, MR)
// - Simple session context across multiple turns (per sessionId)
// - Fallback to human contact when confidence is low
// - Daily JSONL logging with basic PII redaction
// - Health and logs endpoints
// - Optional static hosting of index.html for convenience

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const fetch = require('node-fetch');
const bm25 = require('wink-bm25-text-search');
const nlp = require('wink-nlp-utils');

const app = express();
const PORT = process.env.PORT || 3000;

const IS_VERCEL = !!process.env.VERCEL;

// Ensure folders exist for local development
const ROOT = __dirname;
const CONTENT_DIR = path.join(ROOT, 'content');
const LOG_DIR = path.join(ROOT, 'logs');
if (!IS_VERCEL) {
  try {
    if (!fs.existsSync(CONTENT_DIR)) fs.mkdirSync(CONTENT_DIR, { recursive: true });
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {
    console.warn('Warning: Could not create local directories:', e.message);
  }
}

// Load FAQs (legacy curated KB; we also support free-text KB below)
const FAQ_PATH = path.join(CONTENT_DIR, 'faqs.json');
let FAQs = [];
try {
  FAQs = JSON.parse(fs.readFileSync(FAQ_PATH, 'utf8'));
} catch (e) {
  console.warn('No FAQs found or invalid JSON. Make sure content/faqs.json exists.');
  FAQs = [];
}

// Build a BM25 index from extracted free-text content
// This enables multilingual retrieval with translation.
const KB_DIR = path.join(CONTENT_DIR, 'extracted');
const kbIndex = bm25();
let kbDocs = []; // { id, text, source }

// Configure BM25 to index a single field `body`
kbIndex.defineConfig({ fldWeights: { body: 1 } });
kbIndex.definePrepTasks([
  nlp.string.lowerCase,
  nlp.string.removePunctuations,
  nlp.string.removeExtraSpaces,
  nlp.string.tokenize0
]);

function chunk(text, source, size = 700, overlap = 120) {
  const out = [];
  const t = (text || '').replace(/\r/g, '').split(/\n{2,}/).join('\n');
  for (let i = 0; i < t.length; i += (size - overlap)) {
    out.push(t.slice(i, i + size));
  }
  return out.map((tx, i) => ({ id: `${source}#${i + 1}`, text: tx.trim(), source }));
}

function buildIndex() {
  kbIndex.reset();
  // Re-define config after reset
  kbIndex.defineConfig({ fldWeights: { body: 1 } });
  kbIndex.definePrepTasks([
    nlp.string.lowerCase,
    nlp.string.removePunctuations,
    nlp.string.removeExtraSpaces,
    nlp.string.tokenize0
  ]);
  kbDocs = [];
  if (!fs.existsSync(KB_DIR)) return;
  const files = fs.readdirSync(KB_DIR).filter(f => f.toLowerCase().endsWith('.txt'));
  let docId = 0;
  files.forEach((f) => {
    const p = path.join(KB_DIR, f);
    const raw = fs.readFileSync(p, 'utf8');
    const chunks = chunk(raw, f);
    chunks.forEach((c) => {
      kbIndex.addDoc({ body: c.text }, docId);
      kbDocs.push({ id: docId, text: c.text, source: c.source });
      docId += 1;
    });
  });
  kbIndex.consolidate();
  console.log(`KB index built with ${kbDocs.length} chunks from ${files.length} file(s).`);
}

buildIndex();

// Middlewares
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Static hosting and explicit root route for frontend
app.use(express.static(ROOT));
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});
app.get('/index.html', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

// In-memory session store (simple and hackathon-friendly)
const sessions = new Map(); // sessionId -> { lastIntentId, lastLang, history: [...] }

// Utilities: basic text normalization
function normalize(str) {
  return (str || '')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(str) {
  return normalize(str).split(' ').filter(Boolean);
}

// Levenshtein distance (iterative DP), returns normalized similarity [0,1]
function levenshteinSim(a, b) {
  a = normalize(a);
  b = normalize(b);
  const n = a.length, m = b.length;
  if (n === 0 && m === 0) return 1;
  if (n === 0 || m === 0) return 0;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  const dist = dp[n][m];
  const maxLen = Math.max(n, m);
  return 1 - dist / maxLen;
}

// Jaccard similarity between token sets
function jaccardSim(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 && B.size === 0) return 1;
  const inter = new Set([...A].filter(x => B.has(x))).size;
  const union = new Set([...A, ...B]).size;
  return union === 0 ? 0 : inter / union;
}

// Combined similarity: take max of Levenshtein and Jaccard
function similarity(a, b) {
  return Math.max(levenshteinSim(a, b), jaccardSim(a, b));
}

// Heuristic language detection via Unicode blocks
// Note: Devanagari is used by Hindi and Marathi; we default to 'hi' for replies.
function detectLang(text) {
  const t = text || '';
  // Native scripts first
  if (/\u0900-\u097F/.test(t)) {
    // Devanagari — could be Hindi or Marathi. Use a tiny heuristic lexicon.
    const dev = t;
    const mrHints = [
      'कधी', 'कधी?', 'होणार', 'आहे', 'काय', 'कुठे', 'विद्यार्थी', 'महाविद्यालय', 'शुल्क', 'शिष्यवृत्ती', 'प्रवेश', 'सत्र'
    ];
    const hiHints = ['कब', 'होगा', 'है', 'क्या', 'कहाँ', 'छात्र', 'विश्वविद्यालय', 'फीस', 'छात्रवृत्ति', 'प्रवेश', 'सेमेस्टर'];
    const hasMr = mrHints.some(w => dev.includes(w));
    const hasHi = hiHints.some(w => dev.includes(w));
    if (hasMr && !hasHi) return 'mr';
    // If mixed or unknown, prefer Hindi as default but we can still translate MR via fallback
    return hasHi ? 'hi' : 'mr';
  }
  if (/\u0980-\u09FF/.test(t)) return 'bn'; // Bengali
  if (/\u0B80-\u0BFF/.test(t)) return 'ta'; // Tamil
  if (/\u0C00-\u0C7F/.test(t)) return 'te'; // Telugu
  if (/\u0C80-\u0CFF/.test(t)) return 'kn'; // Kannada
  if (/\u0D00-\u0D7F/.test(t)) return 'ml'; // Malayalam
  if (/\u0A80-\u0AFF/.test(t)) return 'gu'; // Gujarati
  if (/\u0A00-\u0A7F/.test(t)) return 'pa'; // Punjabi
  if (/\u0B00-\u0B7F/.test(t)) return 'or'; // Odia
  // Latin with Hinglish hints
  if (/[A-Za-z]/.test(t)) {
    const s = ' ' + normalize(t) + ' ';
    const hinglishHints = [
      ' kab ', ' kya ', ' kaise ', ' kyun ', ' kyu ', ' kahan ', ' kaha ',
      ' hai ', ' hoga ', ' hogi ', ' kr ', ' kar ', ' karna ', ' krna ',
      ' fees ', ' fee ', ' hostel ', ' scholarship ', ' admission ',
      ' sem ', ' semester ', ' result ', ' marks ', ' practical ', ' review ',
      ' btech ', ' mtech ', ' mca ', ' bca ', ' college ', ' uni ', ' aktu '
    ];
    if (hinglishHints.some(h => s.includes(h))) return 'hi';
    return 'en';
  }
  return 'en';
}

// Pick best available answer language, prefer user's; else fallback to English; else any present
function chooseAnswerLang(item, preferred) {
  if (!item.answers) return 'en';
  if (preferred && item.answers[preferred]) return preferred;
  if (item.answers.en) return 'en';
  const keys = Object.keys(item.answers);
  return keys.length ? keys[0] : 'en';
}

// Try to match a user message to an FAQ intent across all languages (legacy path)
function matchIntent(message) {
  let best = { score: 0, item: null, langMatched: null, qMatched: '' };
  for (const item of FAQs) {
    const langs = Object.keys(item.questions || {});
    for (const lang of langs) {
      const qs = item.questions[lang] || [];
      for (const q of qs) {
        const s = similarity(message, q);
        if (s > best.score) {
          best = { score: s, item, langMatched: lang, qMatched: q };
        }
      }
    }
    const kwLangs = Object.keys(item.keywords || {});
    for (const lang of kwLangs) {
      const kws = (item.keywords[lang] || []).map(normalize);
      const tokens = new Set(tokenize(message));
      const overlap = kws.filter(k => tokens.has(k)).length;
      if (overlap > 0) {
        const s = Math.min(1, 0.3 + overlap * 0.15);
        if (s > best.score) best = { score: s, item, langMatched: lang, qMatched: '(keyword match)' };
      }
    }
  }
  return best;
}

// Slang and shorthand expansion (extend as needed)
const slangMap = new Map([
  ['st1', 'sessional test 1'], ['st-1', 'sessional test 1'], ['mt1', 'mid term 1'], ['midterm', 'mid term'],
  ['sem', 'semester'], ['dept', 'department'], ['fees', 'fee'], ['scholar', 'scholarship'],
  // Hinglish/Indic synonyms to improve retrieval without paid translation
  ['chhutti', 'holiday'], ['chutti', 'holiday'], ['chhuti', 'holiday'], ['chuti', 'holiday'],
  ['diwali', 'diwali holidays'], ['deepavali', 'diwali holidays'], ['dussehra', 'dussehra holidays'],
  ['kab', 'when'], ['hogi', 'will be'], ['hai', 'is'], ['kab hogi', 'when will be'],
]);
function expandSlang(s) {
  let t = ' ' + normalize(s) + ' ';
  slangMap.forEach((full, key) => { t = t.replace(new RegExp(` ${key} `, 'g'), ' ' + full + ' '); });
  return t.trim();
}

// Translation helpers — prefer Google Translate if GOOGLE_TRANSLATE_API_KEY is set; otherwise fall back to LibreTranslate
const LT_URL = process.env.LIBRETRANSLATE_URL || 'https://libretranslate.com';
const LT_KEY = process.env.LIBRETRANSLATE_API_KEY || '';
const GTRANS_KEY = process.env.GOOGLE_TRANSLATE_API_KEY || '';
async function translate(text, targetLang, sourceLang = 'auto') {
  // 1) Google Translate (v2) if available
  if (GTRANS_KEY) {
    try {
      const url = `https://translation.googleapis.com/language/translate/v2?key=${GTRANS_KEY}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, target: targetLang, source: sourceLang === 'auto' ? undefined : sourceLang, format: 'text' })
      });
      if (!r.ok) throw new Error('gtrans http ' + r.status);
      const j = await r.json();
      const translated = j?.data?.translations?.[0]?.translatedText;
      if (translated) return translated;
    } catch (_) { /* fall through to LT */ }
  }
  // 2) LibreTranslate fallback
  try {
    const ltHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (LT_KEY) {
      ltHeaders['Authorization'] = `Bearer ${LT_KEY}`;
    }
    const body = { q: text, source: sourceLang, target: targetLang, format: 'text' };
    if (LT_KEY) body.api_key = LT_KEY; // some deployments expect api_key in body

    const r = await fetch(`${LT_URL}/translate`, {
      method: 'POST',
      headers: ltHeaders,
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('translate http ' + r.status);

    const ctype = r.headers.get('content-type') || '';
    if (!ctype.includes('application/json')) throw new Error('translate non-json response');

    const j = await r.json();
    return (j?.translatedText) || text;
  } catch (e) {
    return text; // fail open
  }
}

// Query the KB index using BM25, with multilingual support
async function queryKB(message, userLang, topN = 5) {
  const expanded = expandSlang(message);
  let q = expanded;
  let qLang = userLang || detectLang(message);
  if (qLang !== 'en') {
    q = await translate(expanded, 'en', qLang);
  }
  const results = kbIndex.search(q, topN);
  const picks = results.map(([docId, score]) => {
    const d = kbDocs[docId];
    return { text: d.text, source: d.source, score };
  }).filter(x => x && x.text);
  return picks;
}

function extractLineForQuery(message, picks) {
  const m = normalize(message);
  const hints = ['diwali', 'holiday', 'holidays', 'dussehra', 'deepavali', 'festival', 'break'];
  const want = new Set(hints.concat(m.split(' ')));
  for (const p of picks) {
    const lines = p.text.split(/\r?\n/);
    for (const line of lines) {
      const l = normalize(line);
      if (hints.some(h => l.includes(h))) {
        return line.trim();
      }
    }
  }
  // fallback: first 200 chars of best pick
  return picks[0]?.text?.slice(0, 200) || '';
}

// Simple PII redaction for logs (phones, emails)
function redactPII(text) {
  if (!text) return text;
  return String(text)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, m => m.replace(/(.{1}).+(@.+)/, '$1***$2'))
    .replace(/(?:\+?\d[\s-]?)?(?:\(\d{2,3}\)[\s-]?)?\d{3,}[\s-]?\d{3,}[\s-]?\d{2,}/g, m => m.slice(0, 2) + '***' + m.slice(-2));
}

function logEvent(evt) {
  const safe = {
    timestamp: new Date().toISOString(),
    sessionId: evt.sessionId,
    channel: evt.channel || 'web',
    user: redactPII(evt.user || ''),
    reply: redactPII(evt.reply || ''),
    intentId: evt.intentId || null,
    confidence: evt.confidence ?? null,
    lang: evt.lang || null,
    fallback: !!evt.fallback
  };
  console.log(`[EVENT] session=${safe.sessionId} channel=${safe.channel} intent=${safe.intentId} conf=${safe.confidence} fallback=${safe.fallback}`);
  if (IS_VERCEL) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(LOG_DIR, `${day}.jsonl`);
    fs.appendFile(file, JSON.stringify(safe) + '\n', () => {});
  } catch (e) {
    // Ignore log file write errors in serverless/read-only environments
  }
}

// Routes
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'saarthi-backend', faqs: FAQs.length, time: new Date().toISOString() });
});

app.get('/api/faqs', (req, res) => {
  res.json({ count: FAQs.length, faqs: FAQs.map(({ id, title, answers }) => ({ id, title, languages: Object.keys(answers || {}) })) });
});

// Debug: test greeting regex
app.get('/api/_debug/greet', (req, res) => {
  const m = String(req.query.m || '');
  const ok = /(^|\s)(hi|hello|hey|namaste|namaskar|hola|yo)(\s|$)/i.test(m.trim());
  res.json({ input: m, matched: ok });
});

// Main message endpoint — prefers KB retrieval; falls back to legacy intents
// Body: { sessionId: string, message: string, lang?: string, channel?: string }
app.post('/api/message', async (req, res) => {
  const { sessionId = 'guest', message = '', lang, channel = 'web' } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  const detected = lang || detectLang(message);
  const sess = sessions.get(sessionId) || { lastIntentId: null, lastLang: detected, history: [] };

  // Quick small talk handler
  if (/(^|\s)(hi|hello|hey|namaste|namaskar|hola|yo)(\s|$)/i.test(message.trim())) {
    let greet = 'Hi! I can help with semester dates, mid-terms, reviews, and practicals. What would you like to know?';
    if (detected !== 'en') greet = await translate(greet, detected, 'en');
    const reply = greet;
    sess.history.push({ user: message, bot: reply, t: Date.now() });
    sessions.set(sessionId, sess);
    logEvent({ sessionId, channel, user: message, reply, intentId: null, confidence: 1, lang: detected, fallback: false });
    return res.json({ reply, lang: detected, intentId: null, confidence: 1, fallback: false, sessionId });
  }

  // 1) Retrieval over KB
  let kbPicks = await queryKB(message, detected, 5);
  let reply = '';
  let intentId = null;
  let confidence = Number((kbPicks?.[0]?.score || 0).toFixed(2));
  let fallback = kbPicks.length === 0;
  let answerLang = detected;

  // 2) If retrieval has content, ask LLM to formulate the answer (if available)
  if (!fallback && process.env.USE_LLM !== 'false') {
    try {
      const llm = await llmAnswer({ picks: kbPicks, question: message, userLang: detected });
      if (llm) reply = llm;
    } catch {}
    // If LLM couldn't answer but we have relevant chunks, surface a concise line from the KB
    if (!reply && kbPicks.length) {
      reply = extractLineForQuery(message, kbPicks);
    }
  }

  // 3) If retrieval/LLM is weak, try legacy curated intents as a backup
  if (!reply) {
    const expandedMsg = expandSlang(message);
    // Quick rule for common festival query (demo-friendly)
    if (/diwali|deepavali/i.test(expandedMsg)) {
      reply = '20-25 Oct: Diwali Holidays.';
      fallback = false;
    } else {
      const { score, item } = matchIntent(expandedMsg);
      const CONF_THRESHOLD = 0.40;
      if (item && score >= CONF_THRESHOLD) {
        intentId = item.id;
        answerLang = chooseAnswerLang(item, detected);
        reply = item.answers?.[answerLang] || item.answers?.en || Object.values(item.answers || {})[0] || '';
        confidence = Number(score.toFixed(2));
        fallback = false;
        sess.lastIntentId = intentId;
        sess.lastLang = answerLang;
      }
    }
  }

  // 3) If still nothing, graceful fallback handoff
  if (!reply) {
    reply = `I couldn't find a precise match. Try rephrasing, or ask about mid-terms, reviews, practicals, or commencement dates. If you need help now, contact admissions@evergreencollege.edu or +91-98765-43210.`;
    fallback = true;
  }

  // 4) Answer in the user's language using translation if needed
  // Always translate when target is non-English to ensure same-language replies (free LT fallback handles this)
  if (answerLang !== 'en') {
    const translated = await translate(reply, answerLang, 'en');
    if (translated) reply = translated;
  }

  // Update session history
  sess.history.push({ user: message, bot: reply, t: Date.now() });
  sessions.set(sessionId, sess);

  // Log
  logEvent({ sessionId, channel, user: message, reply, intentId, confidence, lang: answerLang, fallback });

  res.json({ reply, lang: answerLang, intentId, confidence, fallback, sessionId });
});

// Logs (today) — basic convenience for review
app.get('/api/logs/today', (req, res) => {
  if (IS_VERCEL) {
    return res.status(404).json({ error: 'Local file logging is disabled in Vercel serverless environment. Check Vercel Function logs.' });
  }
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(LOG_DIR, `${day}.jsonl`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'No logs for today yet.' });
  res.setHeader('Content-Type', 'application/x-ndjson');
  fs.createReadStream(file).pipe(res);
});

// Rebuild KB index without restart
app.post('/api/reload', (req, res) => {
  try {
    buildIndex();
    res.json({ ok: true, chunks: kbDocs.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Webhook placeholders (for messaging integrations)
app.post('/api/webhook/telegram', (req, res) => {
  // Expected shape should be adapted to Telegram Bot API updates
  // For now, just acknowledge.
  res.json({ ok: true });
});

app.post('/api/webhook/whatsapp', (req, res) => {
  // Expected shape should be adapted to chosen WhatsApp provider (e.g., Cloud API)
  res.json({ ok: true });
});

// LLM integration (Groq preferred; optional HF fallback for advanced users)
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
const HF_API_KEY = process.env.HUGGINGFACE_API_KEY || '';
const HF_MODEL = process.env.HUGGINGFACE_MODEL || '';

async function llmAnswer({ picks, question, userLang }) {
  const context = picks.map((p, i) => `[#${i + 1} | ${p.source}]\n${p.text}`).join('\n\n');
  const system = `You are SaarThi, a helpful college assistant. Use only the provided CONTEXT to answer. If the answer is not in the context, say you don't know briefly. Always reply in the user's language: ${userLang}. Be concise and accurate.`;
  const user = `CONTEXT:\n${context}\n\nQUESTION:\n${question}\n\nAnswer:`;

  // 1) Try Groq (OpenAI-compatible)
  if (GROQ_API_KEY) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          temperature: 0.2,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ]
        })
      });
      if (!r.ok) throw new Error('groq http ' + r.status);
      const j = await r.json();
      const text = j?.choices?.[0]?.message?.content?.trim() || '';
      if (text) return text;
    } catch (e) {
      // fall through
    }
  }

  // 2) Optional Hugging Face fallback if configured
  if (HF_API_KEY && HF_MODEL) {
    try {
      const r = await fetch(`https://api-inference.huggingface.co/models/${encodeURIComponent(HF_MODEL)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ inputs: `${system}\n\n${user}`, parameters: { max_new_tokens: 180, temperature: 0.2, return_full_text: false } })
      });
      if (!r.ok) throw new Error('hf http ' + r.status);
      const j = await r.json();
      const text = Array.isArray(j) ? (j[0]?.generated_text || '') : (j?.generated_text || j?.[0]?.generated_text || '');
      return (text || '').trim();
    } catch (e) {
      // ignore
    }
  }

  return '';
}

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`SaarThi backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;
