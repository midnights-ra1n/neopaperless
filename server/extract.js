import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// Full text for search. PDFs use poppler's pdftotext; images use tesseract when it is installed.
export async function extractText(filePath, mime) {
  if (mime === 'application/pdf') {
    const text = await run('pdftotext', ['-layout', '-enc', 'UTF-8', filePath, '-']);
    // shortcut: scanned PDFs without a text layer are not OCRed, add pdftoppm+tesseract if needed.
    return text;
  }
  if (mime.startsWith('text/')) return (await fs.readFile(filePath, 'utf8')).slice(0, 5_000_000);
  if (mime.startsWith('image/')) return run('tesseract', [filePath, '-', '-l', process.env.OCR_LANG || 'fra+eng']);
  return '';
}
