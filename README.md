# SaarThi (Evergreen College)

Multilingual conversational assistant backend with a ready frontend in `index.html`.

What you get now:
- A Node.js backend (Express) with endpoints for messages, health, and logs.
- Curated multilingual FAQs (English, Hindi, Bengali, Tamil, Marathi).
- Simple context handling across turns (per sessionId).
- Fallback to human contact details when confidence is low.
- Daily JSONL conversation logs for continuous improvement.

## Run locally (Windows PowerShell)

1) Install dependencies (Node.js 16+ recommended):
```powershell
npm install
```

2) Start the backend:
```powershell
npm start
```
Backend runs at http://localhost:3000

3) Open the frontend:
- Option A: Open `http://localhost:3000/index.html` in your browser (served by backend)
- Option B: Open `index.html` directly from disk (uses existing mock replies)

## API

- POST /api/message
  - Body: `{ sessionId: string, message: string, lang?: string, channel?: string }`
  - Returns: `{ reply, lang, intentId, confidence, fallback, sessionId }`

- GET /api/health — quick status
- GET /api/faqs — list of FAQ intents and available languages
- GET /api/logs/today — NDJSON of today’s interactions

## FAQ curation

Update `content/faqs.json`. Structure per intent:
- `questions`: example queries per language
- `keywords`: tokens per language to boost matching
- `answers`: response per language
- `followups`: optional clarifier per language

After editing, just restart the backend.

## Frontend integration (optional enhancement)

The current `index.html` has a mock bot. To call the backend, replace the logic in `handleUserSend` with a fetch:
```html
<script>
// ...inside handleUserSend(text)
fetch('/api/message', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ sessionId: crypto.randomUUID?.() || 'guest', message: text })
}).then(r => r.json()).then(data => {
  botReply(data.reply || 'Sorry, something went wrong.');
}).catch(() => botReply('Sorry, I could not reach the server.'));
</script>
```

This keeps the backend and frontend decoupled and easy to maintain by student volunteers.

## Privacy & accuracy
- Logs are redacted for basic PII (emails, phone numbers) before writing.
- Low-confidence queries trigger a gentle fallback and human-contact handoff.
- No external model calls or secrets required.

## Messaging channels
Webhook placeholders are available at:
- POST `/api/webhook/telegram`
- POST `/api/webhook/whatsapp`

Integrate these per your provider’s payload format and add token checks as needed.

## Translation configuration
By default, the backend uses Google Translate if `GOOGLE_TRANSLATE_API_KEY` is set. Otherwise it falls back to LibreTranslate.

LibreTranslate public instances now commonly require an API key. To enable translations (e.g., Marathi <-> English) when using LibreTranslate:

- Set the endpoint (optional, defaults to `https://libretranslate.com`):
  - `LIBRETRANSLATE_URL=https://libretranslate.com`
- Set your API key (from https://portal.libretranslate.com or your self-hosted instance):
  - `LIBRETRANSLATE_API_KEY=your_key_here`

Notes:
- The backend sends the key in both the `Authorization: Bearer` header and as `api_key` in the JSON body, for compatibility with different deployments.
- If translation fails or the API returns non-JSON (e.g., an HTML landing page), the system will fail open and proceed with the original text, which can reduce retrieval accuracy for non-English inputs.
- You can also set `GOOGLE_TRANSLATE_API_KEY` to prefer Google Translate instead.
