// tools/test_hf.js
// Safe check for Hugging Face Inference API connectivity without printing secrets.

const fetch = require('node-fetch');
require('dotenv').config();

(async () => {
  const key = process.env.HUGGINGFACE_API_KEY;
  const model = process.env.HUGGINGFACE_MODEL;
  const result = { has_key: !!key, model, ok: false, response: null, error: null };
  if (!key || !model) {
    result.error = 'Missing HUGGINGFACE_API_KEY or HUGGINGFACE_MODEL in .env';
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  try {
    const r = await fetch(`https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: 'Say OK in English.', parameters: { max_new_tokens: 8, return_full_text: false } })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const text = Array.isArray(j) ? (j[0]?.generated_text || '') : (j?.generated_text || '');
    result.ok = true;
    result.response = (text || '').trim().slice(0, 100);
  } catch (e) {
    result.ok = false;
    result.error = e.message;
  }
  console.log(JSON.stringify(result, null, 2));
})();
