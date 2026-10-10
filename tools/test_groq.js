// tools/test_groq.js
// Safe check for Groq OpenAI-compatible API connectivity without printing secrets.

const fetch = require('node-fetch');
require('dotenv').config();

(async () => {
  const key = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';
  const result = { has_key: !!key, model, ok: false, response: null, error: null };
  if (!key) {
    result.error = 'Missing GROQ_API_KEY in .env';
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Reply concisely.' },
          { role: 'user', content: 'Say OK in English.' }
        ],
        temperature: 0.2
      })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    result.ok = true;
    result.response = (j?.choices?.[0]?.message?.content || '').trim().slice(0, 100);
  } catch (e) {
    result.ok = false;
    result.error = e.message;
  }
  console.log(JSON.stringify(result, null, 2));
})();
