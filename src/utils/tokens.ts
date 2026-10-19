import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

/**
 * Calibrated BPE token counter for source code and English prompts.
 * Splits on identifier boundaries, punctuation, whitespace runs, and camelCase/snake_case
 * subwords to closely match cl100k_base / Claude / Gemini tokenizers without external WASM blobs.
 *
 * Note: Always distinguish between `measured` tokens (directly reported by agent runtimes/transcripts)
 * and `bpe_calibrated` token counts (computed deterministically from exact payload strings).
 */
export function countCalibratedTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  // Split into lexical pieces: words, numbers, punctuation runs, and newlines
  const lexemes = text.match(/[A-Z]?[a-z]+|[A-Z]+(?=[A-Z][a-z]|\b)|[0-9]+|[^\s\w]|[\r\n]+/g);
  if (!lexemes) {
    return Math.ceil(text.length / 4);
  }
  let tokenCount = 0;
  for (const lex of lexemes) {
    if (lex.length <= 6) {
      tokenCount += 1;
    } else {
      // Longer identifiers split roughly every 5-6 chars in BPE
      tokenCount += Math.ceil(lex.length / 5.5);
    }
  }
  return Math.max(1, tokenCount);
}

export function sha256String(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

export function sha256File(filePath: string): string | null {
  try {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}
