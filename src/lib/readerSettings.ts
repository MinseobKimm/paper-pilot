import type { DocumentTextLayoutMode } from "./pdfText";
import { cleanAiOutput, parseAiJson, stripJsonFence } from "./textUtils";

const pageTextLayoutAiVersionSettingPrefix = "pageTextLayoutAiVersion:";
const pageTextLayoutSettingPrefix = "pageTextLayout:";
const pageTextLayoutConfidenceSettingPrefix = "pageTextLayoutConfidence:";
const pageTextLayoutSourceSettingPrefix = "pageTextLayoutSource:";
export const pageTextLayoutAiVersion = "page-text-layout-v1";

export const defaultReaderZoom = 1.05;
export const minReaderZoom = 0.55;
export const maxReaderZoom = 2.5;
export const nextPageTranslationReadProgress = 0.82;
export const layoutDefaults = {
  outline: 220,
  translation: 360,
  rightPanel: 340,
};
export const layoutBounds = {
  outline: { min: 160, max: 420, setting: "readerOutlineWidth" },
  translation: { min: 280, max: 680, setting: "readerTranslationWidth" },
  rightPanel: { min: 280, max: 620, setting: "readerRightPanelWidth" },
};

export type LayoutPane = keyof typeof layoutDefaults;

export function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function settingsNumber(settings: Record<string, string>, key: string, fallback: number, min: number, max: number) {
  const value = Number(settings[key]);
  return Number.isFinite(value) ? clampNumber(value, min, max) : fallback;
}

export function documentZoomSettingKey(documentId: string) {
  return `documentZoom:${documentId}`;
}

export function documentHorizontalScrollSettingKey(documentId: string) {
  return `documentScrollLeft:${documentId}`;
}

export function pageTextLayoutAiVersionSettingKey(documentId: string) {
  return `${pageTextLayoutAiVersionSettingPrefix}${documentId}`;
}

export function pageTextLayoutSettingKey(documentId: string, pageNumber: number) {
  return `${pageTextLayoutSettingPrefix}${documentId}:${pageNumber}`;
}

export function pageTextLayoutConfidenceSettingKey(documentId: string, pageNumber: number) {
  return `${pageTextLayoutConfidenceSettingPrefix}${documentId}:${pageNumber}`;
}

export function pageTextLayoutSourceSettingKey(documentId: string, pageNumber: number) {
  return `${pageTextLayoutSourceSettingPrefix}${documentId}:${pageNumber}`;
}

export function normalizeDocumentTextLayoutMode(value: string | null | undefined): DocumentTextLayoutMode | "" {
  if (value === "two-column" || value === "single") {
    return value;
  }
  return "";
}

export function pageTextLayoutModeFromSettings(
  settings: Record<string, string>,
  documentId: string | null | undefined,
  pageNumber: number,
): DocumentTextLayoutMode | "" {
  return documentId ? normalizeDocumentTextLayoutMode(settings[pageTextLayoutSettingKey(documentId, pageNumber)]) : "";
}

export function pageTextLayoutConfidenceFromSettings(
  settings: Record<string, string>,
  documentId: string | null | undefined,
  pageNumber: number,
) {
  if (!documentId) {
    return 0;
  }
  const value = Number(settings[pageTextLayoutConfidenceSettingKey(documentId, pageNumber)]);
  return Number.isFinite(value) ? clampNumber(value, 0, 1) : 0;
}

export function pageTextLayoutModesFromSettings(
  settings: Record<string, string>,
  documentId: string | null | undefined,
  pages: number[],
) {
  return Object.fromEntries(
    pages.map((pageNumber) => [pageNumber, pageTextLayoutModeFromSettings(settings, documentId, pageNumber)]),
  ) as Record<number, DocumentTextLayoutMode | "">;
}

export function zoomFromSettings(settings: Record<string, string>, documentId: string | null) {
  if (!documentId) {
    return defaultReaderZoom;
  }
  return settingsNumber(settings, documentZoomSettingKey(documentId), defaultReaderZoom, minReaderZoom, maxReaderZoom);
}

export function horizontalScrollFromSettings(settings: Record<string, string>, documentId: string | null) {
  if (!documentId) {
    return 0;
  }
  const value = Number(settings[documentHorizontalScrollSettingKey(documentId)]);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

export function parsePageTextLayoutModes(value: string): Array<{ pageNumber: number; mode: DocumentTextLayoutMode }> {
  const readable = stripJsonFence(cleanAiOutput(value));
  const candidates = [readable];
  const jsonMatch = readable.match(/\{[\s\S]*\}/);
  if (jsonMatch && jsonMatch[0] !== readable) {
    candidates.push(jsonMatch[0]);
  }
  for (const candidate of candidates) {
    try {
      const parsed = parseAiJson(candidate);
      const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      const rawPages = record
        ? [record.pages, record.pageLayouts, record.layouts, record.results].find(Array.isArray)
        : null;
      if (!Array.isArray(rawPages)) {
        continue;
      }
      return rawPages
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const pageRecord = item as Record<string, unknown>;
          const pageNumber = Number(pageRecord.page ?? pageRecord.pageNumber ?? pageRecord.p);
          const mode = normalizeDocumentTextLayoutMode(String(pageRecord.layout ?? pageRecord.mode ?? ""));
          return Number.isFinite(pageNumber) && pageNumber > 0 && mode ? { pageNumber: Math.round(pageNumber), mode } : null;
        })
        .filter((item): item is { pageNumber: number; mode: DocumentTextLayoutMode } => Boolean(item));
    } catch {
      // Try the next candidate.
    }
  }
  return [];
}
