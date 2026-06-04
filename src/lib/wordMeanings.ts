import type { AiResultRecord, DocumentRecord, PageRecord } from "../types";
import { makeId, nowIso } from "./ids";
import { cleanAiOutput, normalizeForMatch, parseAiJson, stripJsonFence } from "./textUtils";

export type WordMeaningEntry = {
  id: string;
  word: string;
  meaning: string;
  documentId: string;
  documentTitle: string;
  context: string;
  createdAt: string;
  source: "ai" | "dictionary" | "local";
};

export type WordMeaningMap = Record<string, WordMeaningEntry[]>;

export type OnlineDictionaryCacheEntry = {
  meaning: string;
  source: string;
  fetchedAt: string;
  parserVersion?: string;
};

export type OnlineDictionaryCache = Record<string, OnlineDictionaryCacheEntry>;

export type ParsedWordMeaning = {
  word: string;
  meaning: string;
  context: string;
};

export type DocumentTermCandidate = {
  term: string;
  kind: "word" | "phrase";
  count: number;
  score: number;
  contextNeeded: boolean;
  reason: string;
  examples: string[];
};

export type WordPopup = {
  word: string;
  page: number;
  sourceSentenceId?: string;
  context: string;
  x: number;
  y: number;
  side: "left" | "right";
};

export const wordMeaningMapSettingKey = "wordMeaningMapJson";
export const wordMeaningLookupEnabledSettingKey = "wordMeaningLookupEnabled";
export const onlineDictionaryCacheSettingKey = "onlineDictionaryCacheJson";
export const onlineDictionaryParserVersion = "ko-direct-v3";
export const onlineDictionarySourceLabel = `Korean dictionary APIs ${onlineDictionaryParserVersion}`;
export const wordMeaningBatchLimit = 120;
export const onlineDictionaryBatchLimit = 180;

const documentWordListSettingPrefix = "documentWordList:";

const wordStopWords = new Set([
  "about",
  "above",
  "after",
  "again",
  "against",
  "also",
  "although",
  "among",
  "because",
  "before",
  "between",
  "both",
  "could",
  "does",
  "doing",
  "done",
  "each",
  "from",
  "have",
  "having",
  "into",
  "more",
  "most",
  "other",
  "over",
  "paper",
  "same",
  "some",
  "than",
  "that",
  "their",
  "there",
  "these",
  "this",
  "those",
  "through",
  "under",
  "using",
  "were",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
]);

const phraseConnectorWords = new Set(["and", "as", "by", "for", "from", "in", "of", "on", "to", "via", "with"]);
const technicalSuffixPattern = /(ability|able|al|ance|ence|ation|ative|ator|ence|ency|ent|graph|hood|ibility|ible|ical|ics|ing|ion|ism|ity|ive|ization|ized|izer|less|ment|ness|ology|ous|ship|tion|ty)$/;
const technicalPrefixPattern = /^(amort|auto|bio|chrono|co|cross|de|dis|embedding|graph|hyper|inter|intra|latent|meta|micro|multi|neural|non|post|pre|pseudo|re|self|semi|sub|super|trans|un|zero)/;
const basicKoreanDictionary: Record<string, string> = {
  accuracy: "\uc815\ud655\ub3c4",
  algorithm: "\uc54c\uace0\ub9ac\uc998",
  analysis: "\ubd84\uc11d",
  answer: "\ub2f5",
  approach: "\uc811\uadfc\ubc95",
  architecture: "\uad6c\uc870",
  attention: "\uc5b4\ud150\uc158",
  baseline: "\uae30\uc900 \ubaa8\ub378",
  benchmark: "\ubca4\uce58\ub9c8\ud06c",
  classification: "\ubd84\ub958",
  context: "\ub9e5\ub77d",
  data: "\ub370\uc774\ud130",
  dataset: "\ub370\uc774\ud130\uc14b",
  depth: "\uae4a\uc774",
  difficulty: "\ub09c\uc774\ub3c4",
  document: "\ubb38\uc11c",
  dynamics: "\ub3d9\uc5ed\ud559",
  error: "\uc624\ub958",
  evaluation: "\ud3c9\uac00",
  experiment: "\uc2e4\ud5d8",
  feature: "\ud2b9\uc9d5",
  framework: "\ud504\ub808\uc784\uc6cc\ud06c",
  inference: "\ucd94\ub860",
  input: "\uc785\ub825",
  interplay: "\uc0c1\ud638\uc791\uc6a9",
  known: "\uc54c\ub824\uc9c4",
  language: "\uc5b8\uc5b4",
  learning: "\ud559\uc2b5",
  method: "\ubc29\ubc95",
  minimalist: "\ubbf8\ub2c8\uba40\ud55c",
  model: "\ubaa8\ub378",
  network: "\ub124\ud2b8\uc6cc\ud06c",
  optimization: "\ucd5c\uc801\ud654",
  optimizer: "\ucd5c\uc801\ud654 \uc54c\uace0\ub9ac\uc998",
  output: "\ucd9c\ub825",
  paper: "\ub17c\ubb38",
  parameter: "\ub9e4\uac1c\ubcc0\uc218",
  performance: "\uc131\ub2a5",
  prediction: "\uc608\uce21",
  prompt: "\ud504\ub86c\ud504\ud2b8",
  result: "\uacb0\uacfc",
  reward: "\ubcf4\uc0c1",
  sample: "\uc0d8\ud50c",
  search: "\uac80\uc0c9",
  sentence: "\ubb38\uc7a5",
  sharpness: "\ub0a0\uce74\ub85c\uc6c0",
  signal: "\uc2e0\ud638",
  stability: "\uc548\uc815\uc131",
  stabilization: "\uc548\uc815\ud654",
  stochasticity: "\ud655\ub960\uc131",
  system: "\uc2dc\uc2a4\ud15c",
  task: "\uacfc\uc81c",
  token: "\ud1a0\ud070",
  training: "\ud559\uc2b5",
  transformer: "\ud2b8\ub79c\uc2a4\ud3ec\uba38",
  variable: "\ubcc0\uc218",
};


export function basicDictionaryMeaning(term: string) {
  const key = normalizeWordKey(term);
  if (basicKoreanDictionary[key]) {
    return basicKoreanDictionary[key];
  }
  const singular =
    key.endsWith("ies") && key.length > 4
      ? `${key.slice(0, -3)}y`
      : key.endsWith("es") && key.length > 4
        ? key.slice(0, -2)
        : key.endsWith("s") && key.length > 3
          ? key.slice(0, -1)
          : "";
  return singular ? basicKoreanDictionary[singular] ?? "" : "";
}

export function onlineDictionaryCacheFromSettings(settings: Record<string, string>): OnlineDictionaryCache {
  try {
    const parsed = JSON.parse(settings[onlineDictionaryCacheSettingKey] || "{}") as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const cache: OnlineDictionaryCache = {};
    for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
      const key = normalizeWordKey(rawKey);
      if (!key || !rawValue || typeof rawValue !== "object") {
        continue;
      }
      const record = rawValue as Record<string, unknown>;
      cache[key] = {
        meaning: String(record.meaning ?? ""),
        source: String(record.source ?? "WiktApi/Wiktionary"),
        fetchedAt: String(record.fetchedAt ?? nowIso()),
        parserVersion: typeof record.parserVersion === "string" ? record.parserVersion : undefined,
      };
    }
    return cache;
  } catch {
    return {};
  }
}

export function documentWordListSettingKey(documentId: string) {
  return `${documentWordListSettingPrefix}${documentId}`;
}

export function normalizeWordKey(value: string) {
  return value
    .replace(/\u2019/g, "'")
    .replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

export function isMeaningfulEnglishWord(value: string) {
  const word = normalizeWordKey(value);
  if (word.length < 3 || wordStopWords.has(word)) {
    return false;
  }
  if (!/^[a-z][a-z'-]*[a-z]$|^[a-z]{3,}$/.test(word)) {
    return false;
  }
  return !/^(?:[a-z])$/.test(word);
}

function isPhraseConnector(word: string) {
  return phraseConnectorWords.has(normalizeWordKey(word));
}

export function isMeaningfulEnglishTerm(value: string) {
  const term = normalizeWordKey(value);
  if (!term) {
    return false;
  }
  if (!term.includes(" ")) {
    return isMeaningfulEnglishWord(term);
  }
  return false;
}

function cleanDictionaryMeaning(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[-,;:(){}\[\]\s]+|[-,;:(){}\[\]\s]+$/g, "")
    .trim();
}

function stripExampleText(value: string) {
  return value
    .replace(/\([^)]*(?:예문|예시|예를\s*들어|example|examples)[^)]*\)/gi, " ")
    .split(/(?:\bexamples?\b|예문|예시|예를\s*들어|예\s*:)/i)[0]
    .replace(/[“”"'][^“”"']{8,}[“”"']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasKoreanText(value: string) {
  return /[\uac00-\ud7a3]/.test(value);
}

function looksLikeKoreanExample(value: string) {
  const wordCount = value.split(/\s+/).filter(Boolean).length;
  return wordCount >= 5 && /(?:다|요|니다|했다|한다|된다|였다)[.!?。]?$/.test(value);
}

function koreanDictionaryMeaningParts(value: string) {
  const cleaned = stripExampleText(cleanDictionaryMeaning(value)).replace(/[A-Za-z\u00c0-\u024f\u1d00-\u1d7f\u0250-\u02af]+/g, " ");
  return cleaned
    .split(/[,;\/|]+/)
    .map((part) =>
      part
        .replace(/[^\uac00-\ud7a3\s-]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^-+|-+$/g, "")
        .trim(),
    )
    .filter((part) => hasKoreanText(part) && part.length <= 40 && !looksLikeKoreanExample(part));
}

function normalizeKoreanDictionaryMeaning(value: string) {
  return [...new Set(koreanDictionaryMeaningParts(value))].slice(0, 6).join(", ");
}

export function normalizeOnlineDictionaryMeaning(value: string) {
  return normalizeKoreanDictionaryMeaning(value);
}

function addKoreanDictionaryMeaning(value: string, output: Set<string>, record?: Record<string, unknown>) {
  if (record && isNoisyDictionaryRecord(record)) {
    return;
  }
  for (const meaning of koreanDictionaryMeaningParts(value)) {
    output.add(meaning);
  }
}

function isCurrentDictionaryEntry(entry: WordMeaningEntry) {
  return entry.source !== "dictionary" || entry.context === onlineDictionarySourceLabel;
}

export function hasUsableWordMeaning(entries: WordMeaningEntry[] | undefined) {
  return Boolean(
    entries?.some((entry) =>
      entry.source === "dictionary"
        ? isCurrentDictionaryEntry(entry) && Boolean(normalizeOnlineDictionaryMeaning(entry.meaning))
        : Boolean(entry.meaning.trim()),
    ),
  );
}

export function displayWordMeaning(entry: WordMeaningEntry) {
  return entry.source === "dictionary" ? normalizeOnlineDictionaryMeaning(entry.meaning) : entry.meaning.trim();
}

export function displayWordMeaningEntries(entries: WordMeaningEntry[]) {
  return entries
    .filter(isCurrentDictionaryEntry)
    .map((entry) => ({ ...entry, meaning: displayWordMeaning(entry) }))
    .filter((entry) => entry.meaning.length > 0);
}

function dictionaryRecordText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(dictionaryRecordText).join(" ");
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

function isNoisyDictionaryRecord(record: Record<string, unknown>) {
  const tagText = [
    record.tags,
    record.raw_tags,
    record.topics,
    record.qualifier,
    record.qualifiers,
    record.note,
    record.notes,
    record.usage,
  ]
    .map(dictionaryRecordText)
    .join(" ")
    .toLowerCase();
  return /north korea|north korean|dprk|archaic|obsolete|rare|dialect|dialectal|nonstandard|misspelling|romanization|pronunciation/.test(tagText);
}


function isKoreanDictionaryRecord(record: Record<string, unknown>) {
  const langCode = String(record.lang_code ?? record.code ?? record.langCode ?? "").toLowerCase();
  const lang = String(record.lang ?? record.language ?? record.name ?? "").toLowerCase();
  const nestedLanguage = record.language && typeof record.language === "object" ? (record.language as Record<string, unknown>) : null;
  const nestedCode = String(nestedLanguage?.code ?? "").toLowerCase();
  const nestedName = String(nestedLanguage?.name ?? "").toLowerCase();
  return (
    langCode === "ko" ||
    nestedCode === "ko" ||
    lang === "korean" ||
    lang === "\ud55c\uad6d\uc5b4" ||
    lang.includes("korean") ||
    nestedName === "korean" ||
    nestedName === "\ud55c\uad6d\uc5b4" ||
    nestedName.includes("korean")
  );
}

function collectKoreanDictionaryValues(value: unknown, output: Set<string>, depth = 0, inTranslations = false) {
  if (depth > 8 || value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKoreanDictionaryValues(item, output, depth + 1, inTranslations);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  if (inTranslations && isKoreanDictionaryRecord(record) && !isNoisyDictionaryRecord(record)) {
    for (const field of ["word", "translation", "text", "term", "trans_word"]) {
      const raw = record[field];
      if (typeof raw === "string") {
        addKoreanDictionaryMeaning(raw, output, record);
      }
    }
    return;
  }
  for (const [key, nested] of Object.entries(record)) {
    if (
      [
        "forms",
        "sounds",
        "pronunciations",
        "hyphenation",
        "synonyms",
        "antonyms",
        "derived",
        "related",
        "example",
        "examples",
        "sentences",
        "definition",
        "definitions",
        "gloss",
        "glosses",
      ].includes(key)
    ) {
      continue;
    }
    collectKoreanDictionaryValues(nested, output, depth + 1, inTranslations || key === "translations");
  }
}

function parseOnlineDictionaryMeaning(payload: unknown, rootIsTranslations = false) {
  const values = new Set<string>();
  collectKoreanDictionaryValues(payload, values, 0, rootIsTranslations);
  return [...values]
    .filter((item) => item.length > 0 && item.length <= 80)
    .slice(0, 6)
    .join(", ");
}

function parseMachineTranslatedKoreanMeaning(payload: unknown) {
  const values = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string") {
      for (const meaning of koreanDictionaryMeaningParts(value)) {
        values.add(meaning);
      }
    }
  };
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const responseData = record.responseData && typeof record.responseData === "object" ? (record.responseData as Record<string, unknown>) : null;
    add(responseData?.translatedText);
    if (Array.isArray(record.matches)) {
      for (const match of record.matches) {
        if (match && typeof match === "object") {
          add((match as Record<string, unknown>).translation);
        }
      }
    }
  }
  return [...values]
    .filter((item) => item.length > 0 && item.length <= 80)
    .slice(0, 4)
    .join(", ");
}

function dictionaryLookupCandidates(term: string) {
  const key = normalizeWordKey(term);
  const candidates = new Set<string>(key && !key.includes(" ") ? [key] : []);
  const add = (candidate: string) => {
    const normalized = normalizeWordKey(candidate);
    if (normalized && normalized.length >= 3 && !normalized.includes(" ")) {
      candidates.add(normalized);
    }
  };
  if (key.endsWith("ies") && key.length > 4) {
    add(`${key.slice(0, -3)}y`);
  }
  if (key.endsWith("ves") && key.length > 4) {
    add(`${key.slice(0, -3)}f`);
    add(`${key.slice(0, -3)}fe`);
  }
  if (/(?:ches|shes|xes|zes|ses|oes)$/.test(key) && key.length > 4) {
    add(key.slice(0, -2));
  }
  if (key.endsWith("s") && key.length > 4 && !/(?:ss|us|is)$/.test(key)) {
    add(key.slice(0, -1));
  }
  if (key.endsWith("ing") && key.length > 5) {
    const stem = key.slice(0, -3);
    add(stem);
    add(`${stem}e`);
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) {
      add(stem.slice(0, -1));
    }
  }
  if (key.endsWith("ied") && key.length > 4) {
    add(`${key.slice(0, -3)}y`);
  }
  if (key.endsWith("ed") && key.length > 4) {
    const stem = key.slice(0, -2);
    add(stem);
    add(`${stem}e`);
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) {
      add(stem.slice(0, -1));
    }
  }
  return [...candidates].filter(isMeaningfulEnglishWord);
}

async function fetchOnlineDictionaryMeaningForKey(key: string): Promise<string> {
  const encoded = encodeURIComponent(key);
  const endpoints = [
    { url: `https://api.wiktapi.dev/v1/en/word/${encoded}/translations?lang=ko`, parser: parseOnlineDictionaryMeaning, rootIsTranslations: true },
    { url: `https://api.wiktapi.dev/v1/en/word/${encoded}/translations`, parser: parseOnlineDictionaryMeaning, rootIsTranslations: true },
    { url: `https://freedictionaryapi.com/api/v1/entries/en/${encoded}?translations=true`, parser: parseOnlineDictionaryMeaning, rootIsTranslations: false },
    { url: `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en%7Cko&mt=1`, parser: parseMachineTranslatedKoreanMeaning, rootIsTranslations: false },
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url);
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as unknown;
      const meaning = endpoint.parser(payload, endpoint.rootIsTranslations);
      if (meaning) {
        return meaning;
      }
    } catch {
      continue;
    }
  }
  return "";
}

export async function fetchOnlineDictionaryMeaning(term: string): Promise<string> {
  for (const candidate of dictionaryLookupCandidates(term)) {
    const meaning = await fetchOnlineDictionaryMeaningForKey(candidate);
    if (meaning) {
      return meaning;
    }
  }
  return "";
}

export async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function proseForTermExtraction(text: string) {
  return text
    .replace(/\$[\s\S]*?\$/g, " ")
    .replace(/\\\([^)]+\\\)|\\\[[^\]]+\\\]/g, " ")
    .replace(/\b[a-z]\s*(?:[=+\-*/^<>]\s*[a-z0-9])+\b/gi, " ")
    .replace(/\b(?:argmax|argmin|cos|exp|lim|log|max|min|sin|sqrt|tan)\b/gi, " ");
}

function termTokens(sentence: string) {
  return [...sentence.matchAll(/[A-Za-z](?:[A-Za-z'-]*[A-Za-z])?/g)]
    .map((match) => {
      const raw = match[0];
      const key = normalizeWordKey(raw);
      return {
        raw,
        key,
        start: match.index ?? 0,
        end: (match.index ?? 0) + raw.length,
        content: isMeaningfulEnglishWord(key),
        connector: isPhraseConnector(key),
        acronym: /^[A-Z]{2,}$/.test(raw),
        capitalized: /^[A-Z][a-z]/.test(raw),
      };
    })
    .filter((token) => token.key.length > 0);
}

function isTechnicalWord(word: string) {
  const key = normalizeWordKey(word);
  return (
    key.length >= 9 ||
    key.includes("-") ||
    technicalSuffixPattern.test(key) ||
    technicalPrefixPattern.test(key)
  );
}

function termCandidateScore(term: string, kind: "word" | "phrase", count: number, examples: string[], titleText: string) {
  const key = normalizeWordKey(term);
  const parts = key.split(" ");
  const inTitle = titleText.includes(key);
  const hasAcronym = examples.some((example) => new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(example) && /\b[A-Z]{2,}\b/.test(example));
  const hasHyphen = key.includes("-");
  const technicalParts = parts.filter((part) => isTechnicalWord(part));
  let score = Math.min(18, count * (kind === "phrase" ? 3 : 1.6));
  if (kind === "phrase") score += 14 + Math.min(8, parts.length * 2);
  if (inTitle) score += 8;
  if (hasAcronym) score += 6;
  if (hasHyphen) score += 4;
  score += Math.min(10, technicalParts.length * 3);
  if (basicDictionaryMeaning(key) && kind === "word") score -= 10;
  const contextNeeded =
    kind === "phrase" ||
    inTitle ||
    hasAcronym ||
    hasHyphen ||
    (kind === "word" && !basicDictionaryMeaning(key) && (technicalParts.length > 0 || key.length >= 8 || (count >= 4 && key.length >= 6)));
  const reason = [
    kind === "phrase" ? "phrase" : "word",
    count > 1 ? `freq:${count}` : "",
    inTitle ? "title" : "",
    hasAcronym ? "acronym" : "",
    hasHyphen ? "hyphen" : "",
    technicalParts.length ? "technical" : "",
    basicDictionaryMeaning(key) && kind === "word" ? "basic-dict" : "",
  ]
    .filter(Boolean)
    .join(",");
  return { score, contextNeeded, reason };
}

function addTermCandidate(
  map: Map<string, { term: string; kind: "word" | "phrase"; count: number; first: number; examples: string[] }>,
  term: string,
  kind: "word" | "phrase",
  first: number,
  example: string,
) {
  const key = normalizeWordKey(term);
  if (!isMeaningfulEnglishTerm(key)) {
    return;
  }
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    if (existing.examples.length < 3 && example && !existing.examples.includes(example)) {
      existing.examples.push(example);
    }
    return;
  }
  map.set(key, {
    term: key,
    kind,
    count: 1,
    first,
    examples: example ? [example] : [],
  });
}

export function extractDocumentTermCandidates(pages: PageRecord[], document: DocumentRecord | null = null, limit = 5000): DocumentTermCandidate[] {
  const prose = proseForTermExtraction(pages.map((page) => page.text).join("\n\n"));
  const titleText = normalizeForMatch(`${document?.title ?? ""} ${document?.abstractText ?? ""}`);
  const counts = new Map<string, { display: string; count: number; first: number }>();
  for (const match of prose.matchAll(/[A-Za-z](?:[A-Za-z'-]*[A-Za-z])?/g)) {
    const raw = match[0];
    const key = normalizeWordKey(raw);
    if (!isMeaningfulEnglishWord(key)) {
      continue;
    }
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, {
        display: raw,
        count: 1,
        first: match.index ?? 0,
      });
    }
  }
  const candidates = new Map<string, { term: string; kind: "word" | "phrase"; count: number; first: number; examples: string[] }>();
  for (const [word, value] of counts.entries()) {
    addTermCandidate(candidates, word, "word", value.first, "");
  }
  return [...candidates.values()]
    .map((candidate) => {
      const scored = termCandidateScore(candidate.term, candidate.kind, candidate.count, candidate.examples, titleText);
      return {
        term: candidate.term,
        kind: candidate.kind,
        count: candidate.count,
        score: scored.score,
        contextNeeded: scored.contextNeeded,
        reason: scored.reason,
        examples: candidate.examples,
      };
    })
    .filter((candidate) => candidate.kind === "word" || candidate.count > 1 || candidate.score >= 18)
    .sort((a, b) => b.score - a.score || b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, limit);
}

export function extractEnglishWordsFromPages(pages: PageRecord[], limit = 5000) {
  return extractDocumentTermCandidates(pages, null, limit).map((candidate) => candidate.term);
}

export function parseStoredWordList(settings: Record<string, string>, documentId: string) {
  try {
    const value = settings[documentWordListSettingKey(documentId)];
    const parsed = value ? (JSON.parse(value) as unknown) : [];
    const rows =
      Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { terms?: unknown }).terms)
          ? (parsed as { terms: unknown[] }).terms
          : [];
    return rows.map((word) => normalizeWordKey(String(word))).filter(isMeaningfulEnglishTerm);
  } catch {
    return [];
  }
}

export function wordMeaningMapFromSettings(settings: Record<string, string>): WordMeaningMap {
  try {
    const parsed = JSON.parse(settings[wordMeaningMapSettingKey] || "{}") as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const next: WordMeaningMap = {};
    for (const [rawKey, rawEntries] of Object.entries(parsed as Record<string, unknown>)) {
      const key = normalizeWordKey(rawKey);
      if (!key || !Array.isArray(rawEntries)) {
        continue;
      }
      const entries = rawEntries
        .map((entry): WordMeaningEntry | null => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const record = entry as Record<string, unknown>;
          const word = normalizeWordKey(String(record.word ?? key));
          const meaning = String(record.meaning ?? "").trim();
          if (!word || !meaning) {
            return null;
          }
          return {
            id: String(record.id ?? makeId("wm")),
            word,
            meaning,
            documentId: String(record.documentId ?? ""),
            documentTitle: String(record.documentTitle ?? ""),
            context: String(record.context ?? ""),
            createdAt: String(record.createdAt ?? nowIso()),
            source: record.source === "local" ? "local" : record.source === "dictionary" ? "dictionary" : "ai",
          };
        })
        .filter((entry): entry is WordMeaningEntry => entry !== null);
      if (entries.length > 0) {
        next[key] = entries;
      }
    }
    return next;
  } catch {
    return {};
  }
}

function parsedWordMeaningFromRecord(record: Record<string, unknown>, fallbackWord = ""): ParsedWordMeaning | null {
  const word = normalizeWordKey(String(record.word ?? record.term ?? record.english ?? fallbackWord));
  const meaning = stripExampleText(String(record.meaning ?? record.korean ?? record.translation ?? record.definition ?? "")).trim();
  const context = String(record.context ?? record.reason ?? record.note ?? "").trim();
  if (!word || !meaning || !hasKoreanText(meaning) || looksLikeKoreanExample(meaning)) {
    return null;
  }
  return { word, meaning, context };
}

export function parseWordMeaningItems(outputText: string, fallbackWords: string[] = []): ParsedWordMeaning[] {
  const readable = stripJsonFence(cleanAiOutput(outputText));
  if (!readable) {
    return [];
  }
  const candidates = [readable];
  const jsonMatch = readable.match(/(?:\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch && jsonMatch[0] !== readable) {
    candidates.push(jsonMatch[0]);
  }
  for (const candidate of candidates) {
    try {
      const parsed = parseAiJson(candidate);
      const rows =
        Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === "object" && Array.isArray((parsed as { meanings?: unknown }).meanings)
            ? (parsed as { meanings: unknown[] }).meanings
            : parsed && typeof parsed === "object"
              ? Object.entries(parsed as Record<string, unknown>).map(([word, value]) =>
                  typeof value === "object" && value !== null
                    ? { word, ...(value as Record<string, unknown>) }
                    : { word, meaning: String(value ?? "") },
                )
              : [];
      const parsedRows = rows
        .map((row, index) =>
          row && typeof row === "object"
            ? parsedWordMeaningFromRecord(row as Record<string, unknown>, fallbackWords[index])
            : null,
        )
        .filter((row): row is ParsedWordMeaning => row !== null);
      if (parsedRows.length > 0) {
        return parsedRows;
      }
    } catch {
      continue;
    }
  }
  return readable
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .map((line): ParsedWordMeaning | null => {
      const match = line.match(/^([A-Za-z][A-Za-z' -]{1,90})\s*(?:[:=\-]|->|=>)\s*(.+)$/);
      if (!match) {
        return null;
      }
      return {
        word: normalizeWordKey(match[1]),
        meaning: stripExampleText(match[2]).trim(),
        context: "",
      };
    })
    .filter((row): row is ParsedWordMeaning => row !== null && hasKoreanText(row.meaning) && !looksLikeKoreanExample(row.meaning));
}

export function requestedWordMeaningTerms(result: AiResultRecord, fallbackWords: string[]) {
  const terms = new Set(fallbackWords.map(normalizeWordKey).filter(Boolean));
  const match = result.inputText.match(/^\[word meanings:\s*([^\]]+)\]/i);
  if (match) {
    for (const word of match[1].split(",")) {
      const key = normalizeWordKey(word);
      if (key && key !== "...") {
        terms.add(key);
      }
    }
  }
  return terms;
}

export function clickedWordFromText(raw: string, ratio: number) {
  const matches = [...raw.matchAll(/[A-Za-z](?:[A-Za-z'-]*[A-Za-z])?/g)];
  if (matches.length === 0) {
    return "";
  }
  const charIndex = Math.max(0, Math.min(raw.length, Math.round(raw.length * ratio)));
  const ranked = matches
    .map((match) => {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const distance = charIndex >= start && charIndex <= end ? 0 : Math.min(Math.abs(charIndex - start), Math.abs(charIndex - end));
      return { word: match[0], distance };
    })
    .sort((a, b) => a.distance - b.distance);
  const key = normalizeWordKey(ranked[0]?.word ?? "");
  return isMeaningfulEnglishWord(key) ? key : "";
}

export function clickedWordFromTextSpan(raw: string, ratio: number, combinedWord = "") {
  const word = clickedWordFromText(raw, ratio);
  const combined = normalizeWordKey(combinedWord);
  if (!word || !combined) {
    return word;
  }
  const trimmed = raw.trim();
  const prefix = normalizeWordKey(trimmed.match(/([A-Za-z][A-Za-z']*)-\s*$/)?.[1] ?? "");
  const suffix = normalizeWordKey(trimmed.match(/^([A-Za-z][A-Za-z']*)/)?.[1] ?? "");
  if ((prefix && word === prefix && combined.startsWith(prefix)) || (suffix && word === suffix && combined.endsWith(suffix))) {
    return combined;
  }
  return word;
}

export function annotateHyphenatedTextSpans(layer: HTMLElement) {
  const spans = Array.from(layer.querySelectorAll<HTMLElement>("[data-text]"));
  for (const span of spans) {
    span.dataset.combinedWord = "";
  }
  const orderedSpans = spans.filter((span) => (span.dataset.text ?? "").trim());
  for (let index = 0; index < orderedSpans.length - 1; index += 1) {
    const current = orderedSpans[index];
    const next = orderedSpans[index + 1];
    const prefix = (current.dataset.text ?? "").trim().match(/([A-Za-z][A-Za-z']*)-\s*$/)?.[1] ?? "";
    const suffix = (next.dataset.text ?? "").trim().match(/^([A-Za-z][A-Za-z']*)/)?.[1] ?? "";
    const combined = normalizeWordKey(`${prefix}${suffix}`);
    if (prefix && suffix && isMeaningfulEnglishWord(combined)) {
      current.dataset.combinedWord = combined;
      next.dataset.combinedWord = combined;
    }
  }
}

export function bestTermForWordPopup(popup: WordPopup, knownTerms: string[], meaningMap: WordMeaningMap) {
  const word = normalizeWordKey(popup.word);
  if (!word) {
    return "";
  }
  const candidates = dictionaryLookupCandidates(word);
  const known = new Set(knownTerms.map(normalizeWordKey).filter(Boolean));
  for (const candidate of candidates) {
    if (hasUsableWordMeaning(meaningMap[candidate])) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (known.has(candidate)) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (basicDictionaryMeaning(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? word;
}
