// tools/ingest.js
// Extract raw text from PDFs and save to content/extracted for human review.
// No database updates happen here. After you approve, we will curate Q&A JSON.

const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'content', 'source_pdfs');
const OUT_DIR = path.join(ROOT, 'content', 'extracted');

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = fs.readdirSync(SRC_DIR).filter(f => f.toLowerCase().endsWith('.pdf'));
  if (files.length === 0) {
    console.error('No PDFs found in content/source_pdfs');
    process.exit(1);
  }

  for (const f of files) {
    const inPath = path.join(SRC_DIR, f);
    const outPath = path.join(OUT_DIR, f.replace(/\.pdf$/i, '.txt'));
    const data = fs.readFileSync(inPath);
    try {
      const res = await pdfParse(data);
      const text = res.text || '';
      fs.writeFileSync(outPath, text, 'utf8');
      console.log(`Extracted: ${outPath} (${text.length} chars)`);
    } catch (err) {
      console.error(`Failed to extract ${f}:`, err.message);
    }
  }
})();
