import sentenceTokenizer from "sbd";
import type { AiResultRecord, PageRecord } from "../types";
import { cleanAiOutput, normalizeComparable, normalizeForMatch, parseAiJson, stripJsonFence } from "./textUtils";
import { uiStrings, type UiStrings } from "./uiStrings";

export type SentenceUnit = {
  id: string;
  page: number;
  index: number;
  source: string;
};

export type TranslationPair = {
  id?: string;
  sourceIds?: string[];
  source: string;
  translation: string;
};

export type TranslationUnit = SentenceUnit & {
  translation: string;
  status: "pending" | "complete" | "missing";
  aiSegment?: boolean;
  sourceIds?: string[];
};

export const stalePendingTranslationMs = 20 * 60 * 1000;

export function smartSentenceParts(text: string): string[] {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }
  return sentenceTokenizer
    .sentences(normalized, { sanitize: false, preserve_whitespace: false })
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length > 1);
}

export function sentenceParts(text: string): string[] {
  return smartSentenceParts(text);
}

export function sentenceUnitsForPage(page: PageRecord | undefined): SentenceUnit[] {
  if (!page?.text) {
    return [];
  }
  const parts = smartSentenceParts(page.text);
  return (parts.length ? parts : [page.text.trim()]).map((source, index) => ({
    id: `p${page.pageNumber}-s${index}`,
    page: page.pageNumber,
    index,
    source,
  }));
}


export function parseTranslationLines(outputText: string, expectedCount: number): string[] {
  const readable = stripJsonFence(cleanAiOutput(outputText));
  if (!readable) {
    return [];
  }
  try {
    const parsed = parseAiJson(readable);
    const rows = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { pairs?: unknown }).pairs)
        ? (parsed as { pairs: unknown[] }).pairs
        : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { translations?: unknown }).translations)
          ? (parsed as { translations: unknown[] }).translations
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { sentences?: unknown }).sentences)
        ? (parsed as { sentences: unknown[] }).sentences
        : [];
    const translations = rows
      .map((row) => {
        if (typeof row === "string") {
          return row;
        }
        if (typeof row === "object" && row !== null) {
          const record = row as Record<string, unknown>;
          return String(record.translation ?? record.ko ?? record.korean ?? record.text ?? "");
        }
        return "";
      })
      .map((line) => line.trim())
      .filter(Boolean);
    if (translations.length) {
      return translations;
    }
  } catch {
    // Fall back to line or sentence parsing below.
  }
  const lines = readable
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line && !/^translation task queued/i.test(line) && !/^source text:/i.test(line));
  if (lines.length >= Math.min(2, expectedCount)) {
    return lines;
  }
  return smartSentenceParts(readable);
}

export function parseTranslationPairs(outputText: string): TranslationPair[] {
  const readable = stripJsonFence(cleanAiOutput(outputText));
  if (!readable) {
    return [];
  }
  const parseSourceIds = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value
        .map((item) => String(item ?? "").trim())
        .filter((item) => /^p\d+-s\d+$/.test(item));
    }
    if (typeof value === "string") {
      return value
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter((item) => /^p\d+-s\d+$/.test(item));
    }
    return [];
  };
  try {
    const parsed = parseAiJson(readable);
    const rows = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { pairs?: unknown }).pairs)
        ? (parsed as { pairs: unknown[] }).pairs
        : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { translations?: unknown }).translations)
          ? (parsed as { translations: unknown[] }).translations
          : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { sentences?: unknown }).sentences)
            ? (parsed as { sentences: unknown[] }).sentences
            : [];
    return rows
      .map((row, index): TranslationPair | null => {
        if (typeof row === "string") {
          return { id: `t${index}`, source: "", translation: row.trim() };
        }
        if (typeof row !== "object" || row === null) {
          return null;
        }
        const record = row as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const sourceIds = parseSourceIds(
          record.sourceIds ?? record.source_ids ?? record.sentenceIds ?? record.sentence_ids ?? record.ids ?? (id ? [id] : []),
        );
        const source = String(
          record.source ??
            record.original ??
            record.input ??
            record.sentence ??
            record.en ??
            record.english ??
            "",
        ).trim();
        const translation = String(
          record.translation ??
            record.translated ??
            record.ko ??
            record.korean ??
            (source ? record.text : "") ??
            "",
        ).trim();
        if (!translation) {
          return null;
        }
        return {
          id: id || undefined,
          sourceIds,
          source,
          translation,
        };
      })
      .filter((pair): pair is TranslationPair => pair !== null);
  } catch {
    const pairs: TranslationPair[] = [];
    let pendingSource = "";
    for (const rawLine of readable.split(/\n+/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const sourceMatch = line.match(/^(?:source|original)\s*[:>\-]\s*(.+)$/i);
      if (sourceMatch) {
        pendingSource = sourceMatch[1].trim();
        continue;
      }
      const translationMatch = line.match(/^(?:translation|translated)\s*[:>\-]\s*(.+)$/i);
      if (translationMatch) {
        pairs.push({ sourceIds: [], source: pendingSource, translation: translationMatch[1].trim() });
        pendingSource = "";
      }
    }
    return pairs;
  }
}

export function parseTranslationMap(outputText: string): Map<string, string> {
  const readable = stripJsonFence(cleanAiOutput(outputText));
  const map = new Map<string, string>();
  if (!readable) {
    return map;
  }
  try {
    const parsed = parseAiJson(readable);
    const rows = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { sentences?: unknown }).sentences)
        ? (parsed as { sentences: unknown[] }).sentences
        : [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const record = row as Record<string, unknown>;
      const id = String(record.id ?? "");
      const translation = String(record.translation ?? record.ko ?? record.korean ?? record.text ?? "").trim();
      if (id && translation) {
        map.set(id, translation);
      }
    }
  } catch {
    for (const line of readable.split(/\n+/)) {
      const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*[:>\-]\s*(.+)$/);
      if (match) {
        map.set(match[1], match[2].trim());
      }
    }
  }
  return map;
}


const translationInputMarkerPattern = /^\[translation:\s*([^\]]+)\]\n/i;

export function translationInputText(result: AiResultRecord) {
  return result.inputText.replace(translationInputMarkerPattern, "");
}

export function translationInputLanguage(result: AiResultRecord) {
  return result.inputText.match(translationInputMarkerPattern)?.[1]?.trim() || "Korean";
}

export function translationResultsForPage(
  results: AiResultRecord[],
  page: PageRecord | undefined,
  targetLanguage?: string,
) {
  if (!page?.text) {
    return [];
  }
  return results.filter(
    (result) =>
      result.documentId === page.documentId &&
      result.taskType.toString() === "translatePage" &&
      normalizeComparable(translationInputText(result)) === normalizeComparable(page.text) &&
      (!targetLanguage || translationInputLanguage(result) === targetLanguage),
  );
}

function isLocalQueuedTranslation(result: AiResultRecord) {
  return /translation task queued|a real translation requires/i.test(result.outputText);
}

function translationsForResultUnits(result: AiResultRecord, units: SentenceUnit[]) {
  const lines = parseTranslationLines(cleanAiOutput(result.outputText, result.status), units.length);
  const map = parseTranslationMap(result.outputText);
  const translations = new Map<string, string>();
  units.forEach((unit, index) => {
    const translated = (map.get(unit.id) ?? lines[index] ?? "").trim();
    if (translated) {
      translations.set(unit.id, translated);
    }
  });
  return translations;
}

function bestUnitForSource(source: string, units: SentenceUnit[], usedIds: Set<string>) {
  const normalizedSource = normalizeForMatch(source);
  if (!normalizedSource) {
    return null;
  }
  let best: { unit: SentenceUnit; score: number } | null = null;
  for (const unit of units) {
    if (usedIds.has(unit.id)) {
      continue;
    }
    const normalizedUnit = normalizeForMatch(unit.source);
    if (!normalizedUnit) {
      continue;
    }
    const score =
      normalizedSource === normalizedUnit
        ? 4
        : normalizedSource.includes(normalizedUnit)
          ? normalizedUnit.length / Math.max(1, normalizedSource.length)
          : normalizedUnit.includes(normalizedSource)
            ? normalizedSource.length / Math.max(1, normalizedUnit.length)
            : 0;
    if (score > (best?.score ?? 0)) {
      best = { unit, score };
    }
  }
  return best && best.score >= 0.45 ? best.unit : null;
}

function exactUnitsForSource(source: string, units: SentenceUnit[], usedIds: Set<string>) {
  const normalizedSource = normalizeForMatch(source);
  if (!normalizedSource) {
    return [];
  }
  for (let start = 0; start < units.length; start += 1) {
    if (usedIds.has(units[start].id)) {
      continue;
    }
    const matched: SentenceUnit[] = [];
    let combined = "";
    for (let end = start; end < units.length; end += 1) {
      const unit = units[end];
      if (usedIds.has(unit.id)) {
        break;
      }
      matched.push(unit);
      combined = combined ? `${combined} ${unit.source}` : unit.source;
      const normalizedCombined = normalizeForMatch(combined);
      if (normalizedCombined === normalizedSource) {
        return matched;
      }
      if (normalizedCombined.length > normalizedSource.length + 24) {
        break;
      }
    }
  }
  return [];
}

export function translationPairUnitsForPage(page: PageRecord | undefined, results: AiResultRecord[], targetLanguage?: string) {
  const sourceUnits = sentenceUnitsForPage(page);
  if (!page) {
    return [];
  }
  const sourceUnitById = new Map(sourceUnits.map((unit) => [unit.id, unit]));
  const completeResults = translationResultsForPage(results, page, targetLanguage)
    .filter((result) => result.status === "complete" && !isLocalQueuedTranslation(result));
  for (const result of completeResults) {
    const pairs = parseTranslationPairs(result.outputText);
    if (pairs.length === 0) {
      continue;
    }
    const usedIds = new Set<string>();
    return pairs
      .map((pair, index) => {
        const ids = pair.sourceIds?.length ? pair.sourceIds : pair.id ? [pair.id] : [];
        const idMatchedUnits = ids
          .map((id) => sourceUnitById.get(id))
          .filter((unit): unit is SentenceUnit => unit !== undefined)
          .filter((unit) => !usedIds.has(unit.id));
        const idMatchedSource = idMatchedUnits.map((unit) => unit.source).join(" ");
        const idMatchIsExact =
          idMatchedUnits.length > 0 &&
          (!pair.source || normalizeForMatch(pair.source) === normalizeForMatch(idMatchedSource));
        const matchedUnits = idMatchIsExact ? idMatchedUnits : exactUnitsForSource(pair.source, sourceUnits, usedIds);
        matchedUnits.forEach((unit) => usedIds.add(unit.id));
        const firstMatched = matchedUnits[0] ?? null;
        return {
          id: firstMatched?.id ?? `p${page.pageNumber}-ai${index}`,
          page: page.pageNumber,
          index,
          source: pair.source || matchedUnits.map((unit) => unit.source).join(" "),
          translation: pair.translation,
          status: "complete" as const,
          aiSegment: true,
          sourceIds: matchedUnits.map((unit) => unit.id),
        };
      })
      .filter((unit) => unit.translation && unit.sourceIds.length > 0);
  }
  return [];
}

export function mergedTranslationMapForPage(page: PageRecord | undefined, results: AiResultRecord[], targetLanguage?: string) {
  const units = sentenceUnitsForPage(page);
  const merged = new Map<string, string>();
  if (!page || units.length === 0) {
    return merged;
  }
  const completeResults = translationResultsForPage(results, page, targetLanguage)
    .filter((result) => result.status === "complete" && !isLocalQueuedTranslation(result))
    .reverse();
  for (const result of completeResults) {
    for (const [id, translated] of translationsForResultUnits(result, units)) {
      merged.set(id, translated);
    }
  }
  return merged;
}

export function isFullTranslationResultForPage(result: AiResultRecord, page: PageRecord | undefined) {
  const units = sentenceUnitsForPage(page);
  if (units.length === 0 || result.status !== "complete" || isLocalQueuedTranslation(result)) {
    return false;
  }
  const pairUnits = translationPairUnitsForPage(page, [result]);
  if (pairUnits.some((unit) => (unit.sourceIds?.length ?? 0) > 0)) {
    return true;
  }
  const translations = translationsForResultUnits(result, units);
  return units.every((unit) => translations.has(unit.id));
}

export function isPageFullyTranslated(page: PageRecord | undefined, results: AiResultRecord[], targetLanguage?: string) {
  const units = sentenceUnitsForPage(page);
  if (!page || units.length === 0) {
    return false;
  }
  if (translationPairUnitsForPage(page, results, targetLanguage).some((unit) => (unit.sourceIds?.length ?? 0) > 0)) {
    return true;
  }
  const translations = mergedTranslationMapForPage(page, results, targetLanguage);
  return units.every((unit) => translations.has(unit.id));
}

export function pendingTranslationResultForPage(results: AiResultRecord[], page: PageRecord | undefined, targetLanguage?: string) {
  return (
    translationResultsForPage(results, page, targetLanguage).find(
      (result) => result.status === "pending" && !isStalePendingTranslation(result),
    ) ?? null
  );
}

export function hasCompleteTranslationResultForPage(results: AiResultRecord[], page: PageRecord | undefined, targetLanguage?: string) {
  return translationResultsForPage(results, page, targetLanguage).some((result) => result.status === "complete");
}

export function translationResultForPage(results: AiResultRecord[], page: PageRecord | undefined, targetLanguage?: string) {
  const matches = translationResultsForPage(results, page, targetLanguage);
  return (
    matches.find((result) => isFullTranslationResultForPage(result, page)) ??
    matches.find((result) => result.status === "pending" && !isStalePendingTranslation(result)) ??
    matches.find((result) => result.status === "complete") ??
    null
  );
}

export function translationUnitsForPage(page: PageRecord | undefined, results: AiResultRecord[], targetLanguage?: string): TranslationUnit[] {
  const aiPairUnits = translationPairUnitsForPage(page, results, targetLanguage);
  if (aiPairUnits.length > 0) {
    return aiPairUnits;
  }
  const sourceUnits = sentenceUnitsForPage(page);
  if (!sourceUnits.length) {
    return [];
  }
  const pending = pendingTranslationResultForPage(results, page, targetLanguage);
  const translationMap = mergedTranslationMapForPage(page, results, targetLanguage);
  return sourceUnits.map((unit, index) => ({
    ...unit,
    translation: translationMap.get(unit.id) ?? "",
    status: translationMap.has(unit.id) ? "complete" : pending ? "pending" : "missing",
    sourceIds: [unit.id],
  }));
}

export function hasTranslationRequestForPage(results: AiResultRecord[], page: PageRecord | undefined, targetLanguage?: string) {
  return Boolean(pendingTranslationResultForPage(results, page, targetLanguage) || hasCompleteTranslationResultForPage(results, page, targetLanguage));
}

export function autoHighlightResultsForPage(results: AiResultRecord[], page: PageRecord | undefined) {
  if (!page) {
    return [];
  }
  const pagePattern = new RegExp(`\\bpage\\s+${page.pageNumber}\\b`, "i");
  return results.filter(
    (result) =>
      result.documentId === page.documentId &&
      result.taskType.toString() === "autoHighlight" &&
      result.status !== "failed" &&
      pagePattern.test(result.inputText),
  );
}

export function hasAutoHighlightRequestForPage(results: AiResultRecord[], page: PageRecord | undefined) {
  return autoHighlightResultsForPage(results, page).some(
    (result) => result.status !== "pending" || !isStalePendingTranslation(result),
  );
}


export function translationEntriesForShare(page: PageRecord, aiResults: AiResultRecord[], targetLanguage?: string, ui: UiStrings = uiStrings.ko) {
  const units = translationUnitsForPage(page, aiResults, targetLanguage);
  if (units.length === 0) {
    return [{ label: "", text: ui.noSentencesOnPage }];
  }
  return units.map((unit) => ({
    label: `${unit.index + 1}.`,
    text: unit.translation || (unit.status === "pending" ? ui.translationQueued : ui.translationMissingSaved),
  }));
}


export function isStalePendingTranslation(result: AiResultRecord) {
  if (result.taskType.toString() !== "translatePage" || result.status !== "pending") {
    return false;
  }
  const createdAt = Date.parse(result.createdAt);
  return Number.isFinite(createdAt) && Date.now() - createdAt > stalePendingTranslationMs;
}

export function hasBlockingPendingTranslation(results: AiResultRecord[]) {
  const completedInputs = new Set(
    results
      .filter((result) => result.taskType.toString() === "translatePage" && result.status === "complete")
      .map((result) => normalizeComparable(result.inputText)),
  );
  return results.some(
    (result) =>
      result.taskType.toString() === "translatePage" &&
      result.status === "pending" &&
      !isStalePendingTranslation(result) &&
      !completedInputs.has(normalizeComparable(result.inputText)),
  );
}

export function translationRequestKey(documentId: string, pageNumber: number, text: string, targetLanguage = "Korean") {
  return `${documentId}:${pageNumber}:${targetLanguage}:${normalizeComparable(text).slice(0, 160)}`;
}

export function autoHighlightRequestKey(documentId: string, pageNumber: number, text: string) {
  return `${documentId}:${pageNumber}:${normalizeComparable(text).slice(0, 160)}`;
}

export function sentenceBounds(text: string, units: SentenceUnit[]) {
  let cursor = 0;
  return units.map((unit) => {
    const index = text.indexOf(unit.source, cursor);
    const start = index >= 0 ? index : cursor;
    const end = start + unit.source.length;
    cursor = end;
    return { id: unit.id, start, end };
  });
}
