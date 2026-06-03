import type { AiResultRecord, DocumentContextPack, DocumentRecord, PageRecord } from "../types";
import { joinHyphenatedLineText, medianNumber, textLinesFromBoxes, type TextLayerBox, type TextLine } from "./pdfText";
import { cleanAiOutput, normalizeComparable, normalizeForMatch, parseAiJson, stripJsonFence } from "./textUtils";
import { uiStrings, type UiStrings } from "./uiStrings";

export type OutlineRow = {
  id: string;
  page: number;
  title: string;
  level: number;
  source: "detected" | "ai" | "pdf" | "page" | "pending";
  anchorId?: string;
};

export type OutlineAnchor = {
  id: string;
  page: number;
  title: string;
  level: number;
  top: number;
  left: number;
  width: number;
  height: number;
};

export const aiOutlineVersion = "numeric-two-column-v6";

const documentOutlineVersionSettingPrefix = "documentOutlineVersion:";

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function compactUiText(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 3).trim()}...` : normalized;
}

function tailUiText(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `...${normalized.slice(Math.max(0, normalized.length - limit + 3)).trim()}`;
}

export function documentOutlineVersionSettingKey(documentId: string) {
  return `${documentOutlineVersionSettingPrefix}${documentId}`;
}


export function outlinePagesForAi(pages: PageRecord[], pageCount: number) {
  void pageCount;
  return pages
    .filter((page) => page.text.trim().length >= 20)
    .slice()
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

export function outlineTitleForPage(rows: OutlineRow[], pageNumber: number) {
  return rows
    .filter((row) => row.source !== "pending" && row.page === pageNumber)
    .slice(0, 3)
    .map((row) => row.title)
    .join(" / ");
}

export function buildDocumentContextPack(
  document: DocumentRecord,
  pages: PageRecord[],
  outlineRows: OutlineRow[],
): DocumentContextPack {
  const sortedPages = pages.slice().sort((a, b) => a.pageNumber - b.pageNumber);
  const pageCount = Math.max(document.pageCount || 0, sortedPages.at(-1)?.pageNumber ?? 0, sortedPages.length);
  const extractedPages = sortedPages.filter((page) => page.text.trim().length > 0);
  return {
    documentId: document.id,
    title: document.title,
    pageCount,
    extractedPageCount: extractedPages.length,
    totalTextChars: extractedPages.reduce((sum, page) => sum + page.text.length, 0),
    outline: outlineRows
      .filter((row) => row.source !== "pending")
      .slice(0, 140)
      .map((row) => ({
        pageNumber: row.page,
        title: compactUiText(row.title, 180),
        level: row.level,
        source: row.source,
      })),
    pages: sortedPages.map((page) => {
      const title = outlineTitleForPage(outlineRows, page.pageNumber);
      return {
        pageNumber: page.pageNumber,
        outlineLabel: compactUiText(page.outlineLabel || "", 160),
        detectedTitle: compactUiText(title || page.outlineLabel || "", 180),
        charCount: page.text.length,
        start: compactUiText(page.text, 240),
        end: tailUiText(page.text, 220),
        hasText: page.text.trim().length > 0,
      };
    }),
  };
}


export function outlineAnchorDomId(id: string) {
  return `outline-anchor-${id}`;
}

export function outlineDomToken(value: string) {
  const token = normalizeForMatch(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return token || "section";
}

export function normalizedOutlineText(value: string) {
  return normalizeComparable(value)
    .replace(/\s+([,.;:!?%])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .trim();
}

export function cleanOutlineTitle(value: string, fallback = "Section") {
  const title = normalizedOutlineText(
    value
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\s*[-*]\s+/, "")
      .replace(/^\s*(?:page|p\.?)\s*\d+\s*[:\-]?\s*/i, "")
      .replace(/\s*\((?:page|p\.?)\s*\d+\)\s*/gi, " "),
  );
  const safe = title || fallback;
  return safe.length > 140 ? `${safe.slice(0, 137).trim()}...` : safe;
}


function outlineLevelFromLine(line: string) {
  const heading = line.match(/^\s*(#{1,6})\s+/);
  if (heading) {
    return Math.min(3, heading[1].length - 1);
  }
  const numbered = line.match(/^\s*(\d+(?:\.\d+)+)/);
  if (numbered) {
    return Math.min(3, numbered[1].split(".").length - 1);
  }
  const indent = line.match(/^(\s+)/)?.[1].length ?? 0;
  return Math.min(3, Math.floor(indent / 2));
}

function inferOutlinePage(line: string, title: string, pages: PageRecord[], fallbackPage: number) {
  const explicit = line.match(/\b(?:page|p\.?)\s*(\d{1,4})\b/i);
  if (explicit) {
    const page = Number(explicit[1]);
    if (page >= 1 && page <= Math.max(1, pages.length)) {
      return page;
    }
  }
  const normalizedTitle = normalizeForMatch(title).slice(0, 80);
  if (normalizedTitle.length >= 8) {
    const matched = pages.find(
      (page) =>
        normalizeForMatch(page.outlineLabel).includes(normalizedTitle) ||
        normalizeForMatch(page.text).includes(normalizedTitle),
    );
    if (matched) {
      return matched.pageNumber;
    }
  }
  return Math.max(1, Math.min(Math.max(1, pages.length), fallbackPage));
}

function outlineLevelFromTitle(title: string) {
  const appendix = title.match(/^appendix\s+[A-Z0-9]+(?:\.(\d+))*\b/i);
  if (appendix) {
    const depth = (title.match(/\./g) ?? []).length;
    return clampNumber(depth, 0, 3);
  }
  const numbered = title.match(/^(\d+(?:\.\d+)*)\b/);
  if (!numbered) {
    return 0;
  }
  return clampNumber(numbered[1].split(".").length - 1, 0, 3);
}

const commonOutlineHeadingPattern =
  /^(abstract|introduction|background|related works?|preliminar(?:y|ies)|problem(?: statement| formulation)?|motivation|overview|contributions?|method(?:s|ology)?|approach|model(?:s)?|architecture|design|implementation|algorithm|analysis|experiment(?:s)?|experimental setup|evaluation|results?|ablation(?: study|s)?|discussion|limitations?|conclusion|references|bibliography|acknowledg(?:e)?ments?|appendix)(?:\b|[\s:.-]|$)/i;

function numberedOutlineHeading(value: string) {
  const text = normalizedOutlineText(value);
  const match = text.match(/^(\d{1,2}(?:\.\d{1,2}){0,3}|Appendix\s+[A-Z0-9]+(?:\.\d+)*)(?:[.)]|\s+|(?=[A-Z]))\s*(.+)$/i);
  if (!match) {
    return null;
  }
  const label = match[1];
  const title = match[2].trim();
  if (/^\d+$/.test(label)) {
    const number = Number(label);
    if (number < 1 || number > 20) {
      return null;
    }
  }
  return { label, title };
}

function strictNumberedOutlineHeading(value: string) {
  const text = normalizedOutlineText(value)
    .replace(/^\s*[-*]\s*/, "")
    .replace(/^\s*(?:p\.?|page)\s*\d+\s*[:\-]\s*/i, "")
    .trim();
  const match = text.match(/^(\d{1,2}(?:\.\d{1,2}){0,4})(?:[.)]\s*|\s+|(?=[A-Z]))(.+)$/);
  if (!match) {
    return null;
  }
  const label = match[1];
  const title = match[2].trim();
  if (!title || !/[\p{L}]/u.test(title)) {
    return null;
  }
  const titleStart = title.replace(/^[\s:.)\]-]+/, "");
  if (!/^\p{L}/u.test(titleStart)) {
    return null;
  }
  const parts = label.split(".").map((part) => Number(part));
  if (
    parts.some((part) => !Number.isFinite(part) || part < 0 || part > 99) ||
    parts[0] < 1 ||
    parts[0] > 30 ||
    parts.slice(1).some((part) => part < 1)
  ) {
    return null;
  }
  const letterCount = (title.match(/[\p{L}]/gu) ?? []).length;
  const numericTableTokenCount = (title.match(/\d+(?:\.\d+)?(?:\(\d+(?:\.\d+)?\))?/g) ?? []).length;
  if (numericTableTokenCount >= 3 && numericTableTokenCount > letterCount / 2) {
    return null;
  }
  return { label, title, normalizedTitle: `${label} ${title}` };
}


function isOutlineHeadingStart(text: string) {
  return Boolean(numberedOutlineHeading(text));
}

function commonOutlineHeadingTitle(text: string) {
  const normalized = normalizedOutlineText(text);
  const relatedWorks = normalized.match(/^(related works?)(?:\b|[\s:.-]|$)/i);
  if (relatedWorks) {
    return relatedWorks[1].replace(/\s+/g, " ");
  }
  const match = normalized.match(commonOutlineHeadingPattern);
  return match?.[1]?.replace(/\s+/g, " ") ?? "";
}

function isCommonOutlineHeading(text: string) {
  return Boolean(commonOutlineHeadingTitle(text));
}

function cleanDetectedOutlineTitle(value: string) {
  const title = cleanOutlineTitle(value, "");
  return strictNumberedOutlineHeading(title)?.normalizedTitle ?? "";
}

function isPlausibleDetectedOutlineTitle(title: string) {
  const text = normalizedOutlineText(title);
  if (text.length < 3 || text.length > 140) {
    return false;
  }
  const numbered = numberedOutlineHeading(text);
  if (!numbered && !isCommonOutlineHeading(text)) {
    return false;
  }
  const body = numbered ? numbered.title : text;
  const letterCount = (body.match(/[\p{L}]/gu) ?? []).length;
  const digitCount = (body.match(/\d/g) ?? []).length;
  const mathSymbolCount = (body.match(/[=<>+\-*/^_{}\\|]/g) ?? []).length;
  if (letterCount < 2) {
    return false;
  }
  if (!isCommonOutlineHeading(text) && digitCount > Math.max(2, letterCount)) {
    return false;
  }
  return mathSymbolCount <= Math.max(2, Math.floor(letterCount * 0.35));
}

function isPlausibleAiOutlineTitle(title: string) {
  const text = normalizedOutlineText(title);
  if (text.length < 3 || text.length > 140) {
    return false;
  }
  if (/\b(?:user|assistant|system)\b/i.test(text)) {
    return false;
  }
  const letterCount = (text.match(/[\p{L}]/gu) ?? []).length;
  const digitCount = (text.match(/\d/g) ?? []).length;
  const numericTableTokenCount = (text.match(/\d+(?:\.\d+)?(?:\(\d+(?:\.\d+)?\))?/g) ?? []).length;
  const mathSymbolCount = (text.match(/[=<>+\-*/^_{}\\|]/g) ?? []).length;
  if (letterCount < 2) {
    return false;
  }
  if (numericTableTokenCount >= 3 && numericTableTokenCount > letterCount / 2) {
    return false;
  }
  if (digitCount > Math.max(4, letterCount * 1.2)) {
    return false;
  }
  return mathSymbolCount <= Math.max(2, Math.floor(letterCount * 0.45));
}


function isLikelyOutlineHeading(line: TextLine, medianFont: number, leftMargin: number, pageWidth: number) {
  const text = line.text;
  if (text.length < 4 || text.length > 180) {
    return false;
  }
  const numbered = strictNumberedOutlineHeading(text);
  const startsLikeHeading = Boolean(numbered);
  if (!startsLikeHeading) {
    return false;
  }
  const remainder = numbered ? numbered.title : text;
  const letterCount = (remainder.match(/[\p{L}]/gu) ?? []).length;
  if (letterCount < 2) {
    return false;
  }
  const mathSymbolCount = (remainder.match(/[=<>+\-*/^_{}\\|]/g) ?? []).length;
  if (mathSymbolCount > Math.max(3, letterCount * 1.2) && !/[\p{L}]/u.test(remainder)) {
    return false;
  }
  const lineCenter = line.rect.left + line.rect.width / 2;
  const likelyRightColumn = line.rect.left > pageWidth * 0.42 && lineCenter < pageWidth * 0.98;
  if (!startsLikeHeading && !likelyRightColumn && line.rect.left > leftMargin + pageWidth * 0.18) {
    return false;
  }
  const boldish = line.fontNames.some((name) => /bold|black|heavy|demi|semibold/i.test(name));
  const prominent = line.fontSize >= medianFont * 0.96 || boldish;
  if (!prominent && line.rect.width > pageWidth * 0.88) {
    return false;
  }
  if (/[.!?]$/.test(text) && remainder.length > 36) {
    return false;
  }
  if (!isPlausibleDetectedOutlineTitle(cleanDetectedOutlineTitle(text))) {
    return false;
  }
  return true;
}

export function detectedOutlineAnchorsForPage(
  pageNumber: number,
  boxes: TextLayerBox[],
  pageWidth: number,
  pageHeight: number,
) {
  const lines = textLinesFromBoxes(boxes);
  if (lines.length === 0) {
    return [];
  }
  const leftMargin = Math.min(...lines.map((line) => line.rect.left));
  const medianFont = medianNumber(lines.map((line) => line.fontSize).filter((value) => value > 0));
  const anchors: OutlineAnchor[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isLikelyOutlineHeading(line, medianFont, leftMargin, pageWidth)) {
      continue;
    }
    let merged = line.text;
    let mergedRect = { ...line.rect };
    let lastIndex = index;
    if (isOutlineHeadingStart(line.text)) {
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const next = lines[cursor];
        const verticalGap = next.rect.top - (mergedRect.top + mergedRect.height);
        const similarLeft = Math.abs(next.rect.left - line.rect.left) <= 28;
        const similarFont = Math.abs(next.fontSize - line.fontSize) <= 2.5;
        const nextStartsHeading = isOutlineHeadingStart(next.text) || isCommonOutlineHeading(next.text);
        if (verticalGap > line.rect.height * 1.1 || !similarLeft || !similarFont || nextStartsHeading) {
          break;
        }
        const nextTitle = normalizedOutlineText(joinHyphenatedLineText(merged, next.text).replace(/\n/g, " "));
        if (!isPlausibleDetectedOutlineTitle(cleanDetectedOutlineTitle(nextTitle))) {
          break;
        }
        merged = nextTitle;
        const right = Math.max(mergedRect.left + mergedRect.width, next.rect.left + next.rect.width);
        const bottom = Math.max(mergedRect.top + mergedRect.height, next.rect.top + next.rect.height);
        mergedRect = {
          left: Math.min(mergedRect.left, next.rect.left),
          top: Math.min(mergedRect.top, next.rect.top),
          width: right - Math.min(mergedRect.left, next.rect.left),
          height: bottom - Math.min(mergedRect.top, next.rect.top),
        };
        lastIndex = cursor;
      }
    }
    const title = cleanDetectedOutlineTitle(merged);
    if (!title || !isPlausibleDetectedOutlineTitle(title)) {
      continue;
    }
    const dedupeKey = `${pageNumber}:${outlineLevelFromTitle(title)}:${normalizeForMatch(title)}`;
    if (anchors.some((anchor) => `${anchor.page}:${anchor.level}:${normalizeForMatch(anchor.title)}` === dedupeKey)) {
      index = lastIndex;
      continue;
    }
    anchors.push({
      id: `${pageNumber}-${Math.round(mergedRect.top)}-${outlineDomToken(title).slice(0, 48)}`,
      page: pageNumber,
      title,
      level: outlineLevelFromTitle(title),
      top: clampNumber(mergedRect.top - 8, 0, Math.max(0, pageHeight - 2)),
      left: mergedRect.left,
      width: mergedRect.width,
      height: mergedRect.height,
    });
    index = lastIndex;
  }
  return anchors;
}

function aiOutlineRowsFromResult(result: AiResultRecord, pages: PageRecord[]): OutlineRow[] {
  const readable = cleanAiOutput(result.outputText, result.status);
  try {
    const parsed = parseAiJson(stripJsonFence(cleanAiOutput(readable)));
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { outline?: unknown }).outline)
        ? (parsed as { outline: unknown[] }).outline
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { sections?: unknown }).sections)
          ? (parsed as { sections: unknown[] }).sections
          : [];
    const parsedRows = rows
      .map((row, order) => (row && typeof row === "object" ? outlineRowFromAiRecord(row as Record<string, unknown>, order, pages) : null))
      .filter((row): row is OutlineRow & { order: number } => row !== null)
      .sort(compareOutlineRows)
      .slice(0, 120)
      .map(({ order: _order, ...row }) => row);
    if (parsedRows.length > 0) {
      return parsedRows;
    }
  } catch {
    // Fall back to line parsing below.
  }
  const lines = readable
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 2 && !/^local explanation draft/i.test(line));
  const rows: Array<OutlineRow & { order: number }> = [];
  for (const [order, line] of lines.entries()) {
    const title = cleanStrictNumberedOutlineTitle(line);
    if (!title || /^(no extracted|task queued|agent)/i.test(title) || !isPlausibleAiOutlineTitle(title)) {
      continue;
    }
    const page = inferOutlinePage(line, title, pages, rows.length + 1);
    rows.push({
      id: `ai-outline-${rows.length}-${page}-${title}`,
      page,
      title,
      level: outlineLevelFromTitle(title),
      source: "ai",
      order,
    });
    if (rows.length >= 60) {
      break;
    }
  }
  return rows
    .sort((a, b) => a.page - b.page || a.order - b.order)
    .map(({ order: _order, ...row }) => row);
}

export function parseAiOutlineRows(results: AiResultRecord[], pages: PageRecord[]): OutlineRow[] {
  const candidates = results.filter(
    (result) =>
      result.taskType.toString() === "outlineDocument" &&
      result.status !== "pending" &&
      result.status !== "failed",
  );
  for (const result of candidates) {
    const rows = aiOutlineRowsFromResult(result, pages);
    if (rows.length > 0) {
      return rows;
    }
  }
  return [];
}

function isFreshPendingOutlineResult(result: AiResultRecord) {
  if (result.taskType.toString() !== "outlineDocument" || result.status !== "pending") {
    return false;
  }
  const createdAt = new Date(result.createdAt).getTime();
  if (!Number.isFinite(createdAt)) {
    return true;
  }
  return Date.now() - createdAt < 15 * 60 * 1000;
}

export function hasFreshPendingOutlineResult(results: AiResultRecord[]) {
  return results.some(isFreshPendingOutlineResult);
}

export function outlineRowsFromAnchors(anchors: OutlineAnchor[]) {
  return anchors
    .slice()
    .sort((a, b) => a.page - b.page || a.top - b.top)
    .map(
      (anchor) =>
        ({
          id: anchor.id,
          page: anchor.page,
          title: anchor.title,
          level: anchor.level,
          source: "detected",
          anchorId: anchor.id,
        }) satisfies OutlineRow,
    );
}

function cleanStrictNumberedOutlineTitle(value: string) {
  const stripped = normalizedOutlineText(value)
    .replace(/^\s*[-*]\s*/, "")
    .replace(/^\s*(?:p\.?|page)\s*\d+\s*[:\-]\s*/i, "")
    .trim();
  return strictNumberedOutlineHeading(stripped)?.normalizedTitle ?? "";
}

function outlineRowFromAiRecord(record: Record<string, unknown>, order: number, pages: PageRecord[]): (OutlineRow & { order: number }) | null {
  const number = String(record.number ?? record.label ?? record.section ?? "").trim();
  const rawTitle = String(record.title ?? record.heading ?? record.text ?? record.anchorText ?? "").trim();
  const candidateTitle = cleanStrictNumberedOutlineTitle(number && rawTitle && !rawTitle.startsWith(number) ? `${number} ${rawTitle}` : rawTitle || number);
  if (!candidateTitle || !isPlausibleAiOutlineTitle(candidateTitle)) {
    return null;
  }
  const rawPage = Number(record.page ?? record.pageNumber ?? record.p);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.round(rawPage) : inferOutlinePage("", candidateTitle, pages, order + 1);
  const rawLevel = Number(record.level);
  return {
    id: `ai-outline-${order}-${page}-${candidateTitle}`,
    page,
    title: candidateTitle,
    level: Number.isFinite(rawLevel) ? clampNumber(Math.round(rawLevel), 0, 4) : outlineLevelFromTitle(candidateTitle),
    source: "ai",
    order,
  };
}

function fallbackOutlineRows(pdfRows: OutlineRow[], pages: PageRecord[]): OutlineRow[] {
  if (pdfRows.length) {
    return pdfRows.slice(0, 60);
  }
  return pages.slice(0, 36).map((page) => ({
    id: `page-outline-${page.pageNumber}`,
    page: page.pageNumber,
    title: cleanOutlineTitle(page.outlineLabel || page.text, `Page ${page.pageNumber}`),
    level: 0,
    source: "page",
  }));
}

function outlineCanonicalKey(title: string) {
  const cleaned = cleanOutlineTitle(title, "");
  const numbered = numberedOutlineHeading(cleaned);
  if (numbered) {
    return `number:${numbered.label.toLowerCase()}`;
  }
  return `title:${normalizeForMatch(cleaned)
    .replace(/^\d{1,2}(?:\.\d{1,2}){0,3}\s*/, "")
    .replace(/\bworks\b/g, "work")
    .replace(/[^a-z0-9]+/g, "")}`;
}

function outlineNumberParts(title: string) {
  const label = numberedOutlineHeading(title)?.label ?? "";
  if (!/^\d+(?:\.\d+)*$/.test(label)) {
    return [];
  }
  return label.split(".").map((part) => Number(part));
}

export function compareOutlineRows(a: OutlineRow, b: OutlineRow) {
  const aParts = outlineNumberParts(a.title);
  const bParts = outlineNumberParts(b.title);
  if (aParts.length && bParts.length) {
    const length = Math.max(aParts.length, bParts.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (aParts[index] ?? -1) - (bParts[index] ?? -1);
      if (diff !== 0) {
        return diff;
      }
    }
  }
  return a.page - b.page || a.level - b.level || a.title.localeCompare(b.title);
}

export function mergedOutlineRows(...groups: OutlineRow[][]): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const row of group) {
      if (!row.title.trim() || row.source === "pending") {
        continue;
      }
      const key = outlineCanonicalKey(row.title);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push(row);
    }
  }
  return rows
    .sort(compareOutlineRows)
    .slice(0, 120);
}

export function strictNumberedOutlineRows(rows: OutlineRow[]) {
  const seen = new Set<string>();
  return rows
    .map((row) => {
      const title = cleanStrictNumberedOutlineTitle(row.title);
      return title ? { ...row, title, level: outlineLevelFromTitle(title) } : null;
    })
    .filter((row): row is OutlineRow => row !== null)
    .sort(compareOutlineRows)
    .filter((row) => {
      const key = outlineCanonicalKey(row.title);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 120);
}

export function readerOutlineRows(
  results: AiResultRecord[],
  pdfRows: OutlineRow[],
  pages: PageRecord[],
  anchors: OutlineAnchor[],
  ui: UiStrings = uiStrings.ko,
): OutlineRow[] {
  const aiRows = strictNumberedOutlineRows(parseAiOutlineRows(results, pages));
  if (aiRows.length > 0) {
    return aiRows;
  }
  const pdfNumberedRows = strictNumberedOutlineRows(pdfRows);
  if (pdfNumberedRows.length > 0) {
    return pdfNumberedRows;
  }
  const detectedRows = strictNumberedOutlineRows(outlineRowsFromAnchors(anchors));
  if (detectedRows.length > 0) {
    return detectedRows;
  }
  if (hasFreshPendingOutlineResult(results)) {
    return [
      {
        id: "ai-outline-pending",
        page: 1,
        title: ui.aiOutlinePending,
        level: 0,
        source: "pending" as const,
      },
    ];
  }
  return [];
}
