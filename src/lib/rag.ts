import type { PageRecord, RagContext, RagHit } from "../types";

const defaultTopK = 6;
const defaultMaxChars = 6000;
const defaultMaxChunksPerPage = 2;
const chunkSentenceTarget = 4;
const chunkCharTarget = 900;
const overlapSentences = 1;

type Chunk = {
  id: string;
  documentId: string;
  pageNumber: number;
  chunkIndex: number;
  text: string;
  tokens: string[];
  termCounts: Map<string, number>;
};

type RagOptions = {
  topK?: number;
  maxChars?: number;
  maxChunksPerPage?: number;
};

type ScoredChunk = {
  chunk: Chunk;
  score: number;
  matchedTerms: string[];
};

const stopWords = new Set([
  "about",
  "after",
  "again",
  "against",
  "also",
  "and",
  "are",
  "because",
  "between",
  "can",
  "could",
  "does",
  "from",
  "have",
  "into",
  "paper",
  "show",
  "study",
  "that",
  "the",
  "their",
  "there",
  "these",
  "this",
  "those",
  "through",
  "using",
  "were",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

function sanitizeText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEnglishToken(token: string): string {
  if (!/^[a-z0-9-]+$/.test(token)) {
    return token;
  }
  if (token.length > 5 && token.endsWith("ies")) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 6 && token.endsWith("ing")) {
    return token.slice(0, -3);
  }
  if (token.length > 5 && token.endsWith("ed")) {
    return token.slice(0, -2);
  }
  if (token.length > 4 && token.endsWith("es")) {
    return token.slice(0, -2);
  }
  if (token.length > 4 && token.endsWith("s")) {
    return token.slice(0, -1);
  }
  return token;
}

function tokenize(text: string): string[] {
  const matches = text
    .normalize("NFKC")
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9-]{1,}|[\uac00-\ud7a3]{2,}/g);
  if (!matches) {
    return [];
  }
  return matches
    .map(normalizeEnglishToken)
    .filter((token) => token.length > 1 && !stopWords.has(token));
}

function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= chunkCharTarget) {
    return [sentence];
  }
  const pieces: string[] = [];
  let cursor = 0;
  while (cursor < sentence.length) {
    const end = Math.min(sentence.length, cursor + chunkCharTarget);
    const slice = sentence.slice(cursor, end);
    const splitAt = slice.length > 500 ? slice.lastIndexOf(" ") : -1;
    const piece = slice.slice(0, splitAt > 500 ? splitAt : slice.length).trim();
    if (piece) {
      pieces.push(piece);
    }
    cursor += piece.length || chunkCharTarget;
    while (sentence[cursor] === " ") {
      cursor += 1;
    }
  }
  return pieces;
}

function splitSentences(text: string): string[] {
  const clean = sanitizeText(text);
  if (!clean) {
    return [];
  }
  const matches = clean.match(/[^.!?]+[.!?]?/g) ?? [clean];
  return matches.flatMap((sentence) => splitLongSentence(sentence.trim())).filter(Boolean);
}

function termCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

function makeChunks(pages: PageRecord[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const page of pages) {
    const sentences = splitSentences(page.text);
    if (sentences.length === 0) {
      continue;
    }
    let sentenceIndex = 0;
    let chunkIndex = 0;
    while (sentenceIndex < sentences.length) {
      const selected: string[] = [];
      let charCount = 0;
      let cursor = sentenceIndex;
      while (cursor < sentences.length && selected.length < chunkSentenceTarget) {
        const sentence = sentences[cursor];
        const nextCount = charCount + sentence.length + (selected.length ? 1 : 0);
        if (selected.length > 0 && nextCount > chunkCharTarget) {
          break;
        }
        selected.push(sentence);
        charCount = nextCount;
        cursor += 1;
        if (charCount >= chunkCharTarget) {
          break;
        }
      }
      const text = selected.join(" ").trim();
      const tokens = tokenize(text);
      if (text && tokens.length) {
        chunks.push({
          id: `${page.documentId}:${page.pageNumber}:${chunkIndex}`,
          documentId: page.documentId,
          pageNumber: page.pageNumber,
          chunkIndex,
          text,
          tokens,
          termCounts: termCounts(tokens),
        });
        chunkIndex += 1;
      }
      if (cursor <= sentenceIndex) {
        sentenceIndex += 1;
      } else if (selected.length > overlapSentences) {
        sentenceIndex = Math.max(sentenceIndex + 1, cursor - overlapSentences);
      } else {
        sentenceIndex = cursor;
      }
    }
  }
  return chunks;
}

function uniqueTokens(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

function scoreChunks(queryTokens: string[], chunks: Chunk[]): ScoredChunk[] {
  if (queryTokens.length === 0 || chunks.length === 0) {
    return [];
  }
  const uniqueQueryTokens = uniqueTokens(queryTokens);
  const documentFrequency = new Map<string, number>();
  for (const token of uniqueQueryTokens) {
    documentFrequency.set(
      token,
      chunks.reduce((count, chunk) => count + (chunk.termCounts.has(token) ? 1 : 0), 0),
    );
  }
  const averageLength = chunks.reduce((sum, chunk) => sum + chunk.tokens.length, 0) / chunks.length || 1;
  const k1 = 1.2;
  const b = 0.75;
  return chunks
    .map((chunk) => {
      let score = 0;
      const matchedTerms: string[] = [];
      for (const token of uniqueQueryTokens) {
        const frequency = chunk.termCounts.get(token) ?? 0;
        if (frequency === 0) {
          continue;
        }
        matchedTerms.push(token);
        const df = documentFrequency.get(token) ?? 0;
        const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
        const lengthNorm = frequency + k1 * (1 - b + b * (chunk.tokens.length / averageLength));
        score += idf * ((frequency * (k1 + 1)) / lengthNorm);
      }
      return { chunk, score, matchedTerms };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.chunk.pageNumber - b.chunk.pageNumber);
}

function applyLimits(
  scored: ReturnType<typeof scoreChunks>,
  topK: number,
  maxChars: number,
  maxChunksPerPage: number,
): RagHit[] {
  const pageCounts = new Map<number, number>();
  const hits: RagHit[] = [];
  let usedChars = 0;
  for (const item of scored) {
    if (hits.length >= topK) {
      break;
    }
    const pageCount = pageCounts.get(item.chunk.pageNumber) ?? 0;
    if (pageCount >= maxChunksPerPage) {
      continue;
    }
    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      break;
    }
    const text =
      item.chunk.text.length > remaining
        ? `${item.chunk.text.slice(0, Math.max(0, remaining - 3))}...`
        : item.chunk.text;
    if (!text) {
      break;
    }
    hits.push({
      id: item.chunk.id,
      documentId: item.chunk.documentId,
      pageNumber: item.chunk.pageNumber,
      chunkIndex: item.chunk.chunkIndex,
      text,
      score: Number(item.score.toFixed(4)),
      matchedTerms: item.matchedTerms,
    });
    pageCounts.set(item.chunk.pageNumber, pageCount + 1);
    usedChars += text.length;
  }
  return hits;
}

export function buildRagContext(query: string, pages: PageRecord[], options: RagOptions = {}): RagContext {
  const maxChars = options.maxChars ?? defaultMaxChars;
  const chunks = makeChunks(pages);
  const queryTokens = tokenize(query);
  const scored = scoreChunks(queryTokens, chunks);
  const hits = applyLimits(
    scored,
    options.topK ?? defaultTopK,
    maxChars,
    options.maxChunksPerPage ?? defaultMaxChunksPerPage,
  );
  const uniqueQueryTokenCount = uniqueTokens(queryTokens).length;
  const minimumMatchedTerms = uniqueQueryTokenCount <= 2 ? 1 : 2;
  const hasStrongMatch =
    hits.length > 0 &&
    (hits[0].matchedTerms.length >= minimumMatchedTerms || hits[0].score >= 2);
  return {
    query: sanitizeText(query),
    hits,
    hitCount: hits.length,
    totalChunks: chunks.length,
    hasStrongMatch,
    maxChars,
  };
}
