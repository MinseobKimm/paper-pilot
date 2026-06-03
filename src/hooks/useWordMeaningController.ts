import { useEffect, useState } from "react";
import type { AiResultRecord, AiTaskType, AppStateRecord, DocumentRecord, PageRecord } from "../types";
import { makeId, nowIso } from "../lib/ids";
import { selectedCodexReasoningEffort } from "../lib/aiPreferences";
import { wordMeaningLookupEnabled } from "../lib/appState";
import type { DocumentTextLayoutMode } from "../lib/pdfText";
import {
  pageTextLayoutConfidenceSettingKey,
  pageTextLayoutSettingKey,
  pageTextLayoutSourceSettingKey,
  parseDocumentTextLayoutMode,
  parsePageTextLayoutModes,
} from "../lib/readerSettings";
import { setSetting } from "../lib/tauri";
import { normalizeComparable } from "../lib/textUtils";
import type { UiLanguage, UiStrings } from "../lib/uiStrings";
import { wordMeaningTaskType } from "../lib/aiResults";
import {
  basicDictionaryMeaning,
  bestTermForWordPopup,
  documentWordListSettingKey,
  extractDocumentTermCandidates,
  fetchOnlineDictionaryMeaning,
  hasUsableWordMeaning,
  mapWithConcurrency,
  normalizeOnlineDictionaryMeaning,
  normalizeWordKey,
  onlineDictionaryBatchLimit,
  onlineDictionaryCacheFromSettings,
  onlineDictionaryCacheSettingKey,
  onlineDictionaryParserVersion,
  onlineDictionarySourceLabel,
  parseWordMeaningItems,
  requestedWordMeaningTerms,
  wordMeaningBatchLimit,
  wordMeaningMapFromSettings,
  wordMeaningMapSettingKey,
  type WordMeaningMap,
  type WordPopup,
} from "../lib/wordMeanings";

type PatchState = (mutator: (draft: AppStateRecord) => void) => void;

type QueueTask = (
  taskType: AiTaskType,
  payload: Record<string, unknown>,
  options?: { silent?: boolean; keepPanel?: boolean },
) => Promise<AiResultRecord | null>;

type WordMeaningControllerInput = {
  state: AppStateRecord;
  activeDocument: DocumentRecord | null;
  activePages: PageRecord[];
  activeDocumentWordList: string[];
  wordMeaningMap: WordMeaningMap;
  markupToolKind: "none" | "highlight" | "erase";
  ui: UiStrings;
  uiLanguage: UiLanguage;
  patchState: PatchState;
  showToast: (message: string, kind?: "info" | "error") => void;
  queueTask: QueueTask;
  ensureActivePages: () => Promise<PageRecord[]>;
  persistDocumentTextLayoutMode: (documentId: string, mode: DocumentTextLayoutMode) => Promise<void>;
};

export function useWordMeaningController(input: WordMeaningControllerInput) {
  const {
    state,
    activeDocument,
    activePages,
    activeDocumentWordList,
    wordMeaningMap,
    markupToolKind,
    ui,
    uiLanguage,
    patchState,
    showToast,
    queueTask,
    ensureActivePages,
    persistDocumentTextLayoutMode,
  } = input;
  const [wordPopup, setWordPopup] = useState<WordPopup | null>(null);
  const [wordLookupLoadingKey, setWordLookupLoadingKey] = useState<string | null>(null);
  async function persistWordListForPages(documentId: string, pages: PageRecord[]) {
    const document = state.documents.find((item) => item.id === documentId) ?? activeDocument;
    const candidates = extractDocumentTermCandidates(pages, document);
    const terms = candidates.map((candidate) => candidate.term);
    if (terms.length === 0) {
      return terms;
    }
    const key = documentWordListSettingKey(documentId);
    const value = JSON.stringify({
      terms,
      candidates: candidates.slice(0, 1500),
    });
    if (state.settings[key] === value) {
      return terms;
    }
    patchState((draft) => {
      draft.settings[key] = value;
    });
    await setSetting(key, value);
    return terms;
  }

  async function saveWordMeaningsFromResult(result: AiResultRecord, fallbackWords: string[] = []) {
    if (result.status === "failed" || result.taskType.toString() !== wordMeaningTaskType) {
      return 0;
    }
    const requestedTerms = requestedWordMeaningTerms(result, fallbackWords);
    const meanings = parseWordMeaningItems(result.outputText, fallbackWords)
      .filter((item) => requestedTerms.size === 0 || requestedTerms.has(normalizeWordKey(item.word)))
      .slice(0, wordMeaningBatchLimit);
    if (meanings.length === 0) {
      return 0;
    }
    const document = state.documents.find((item) => item.id === result.documentId) ?? activeDocument;
    const nextMap = wordMeaningMapFromSettings(state.settings);
    let added = 0;
    for (const item of meanings) {
      const key = normalizeWordKey(item.word);
      const meaning = item.meaning.trim();
      if (!key || !meaning) {
        continue;
      }
      const entries = nextMap[key] ?? [];
      const duplicate = entries.some(
        (entry) =>
          entry.documentId === result.documentId &&
          normalizeComparable(entry.meaning) === normalizeComparable(meaning) &&
          normalizeComparable(entry.context) === normalizeComparable(item.context),
      );
      if (duplicate) {
        continue;
      }
      entries.push({
        id: makeId("wm"),
        word: key,
        meaning,
        documentId: result.documentId,
        documentTitle: document?.title || document?.fileName || ui.untitledPaper,
        context: item.context,
        createdAt: nowIso(),
        source: result.provider === "local-draft" ? "local" : "ai",
      });
      nextMap[key] = entries;
      added += 1;
    }
    if (added === 0) {
      return 0;
    }
    const value = JSON.stringify(nextMap);
    patchState((draft) => {
      draft.settings[wordMeaningMapSettingKey] = value;
    });
    await setSetting(wordMeaningMapSettingKey, value);
    const requestedCount = requestedTerms.size || meanings.length;
    const remaining = Math.max(0, requestedCount - added);
    showToast(
      uiLanguage === "ko"
        ? `단어 뜻: 요청 ${requestedCount}개 / 저장 ${added}개 / 남음 ${remaining}개`
        : `Word meanings: requested ${requestedCount} / saved ${added} / remaining ${remaining}`,
    );
    return added;
  }

  async function persistWordMeaningMap(nextMap: WordMeaningMap) {
    const value = JSON.stringify(nextMap);
    patchState((draft) => {
      draft.settings[wordMeaningMapSettingKey] = value;
    });
    await setSetting(wordMeaningMapSettingKey, value);
  }

  async function saveDocumentLayoutFromResult(result: AiResultRecord) {
    if (result.taskType.toString() !== "classifyDocumentLayout" || result.status === "failed") {
      return;
    }
    const pageModes = parsePageTextLayoutModes(result.outputText);
    if (pageModes.length > 0) {
      patchState((draft) => {
        for (const page of pageModes) {
          draft.settings[pageTextLayoutSettingKey(result.documentId, page.pageNumber)] = page.mode;
          draft.settings[pageTextLayoutConfidenceSettingKey(result.documentId, page.pageNumber)] = "0.86";
          draft.settings[pageTextLayoutSourceSettingKey(result.documentId, page.pageNumber)] = "ai";
        }
      });
      await Promise.all(
        pageModes.flatMap((page) => [
          setSetting(pageTextLayoutSettingKey(result.documentId, page.pageNumber), page.mode),
          setSetting(pageTextLayoutConfidenceSettingKey(result.documentId, page.pageNumber), "0.86"),
          setSetting(pageTextLayoutSourceSettingKey(result.documentId, page.pageNumber), "ai"),
        ]),
      );
      const twoColumnCount = pageModes.filter((page) => page.mode === "two-column").length;
      const documentMode = twoColumnCount >= Math.max(1, Math.ceil(pageModes.length * 0.35)) ? "two-column" : "single";
      await persistDocumentTextLayoutMode(result.documentId, documentMode);
      return;
    }
    const mode = parseDocumentTextLayoutMode(result.outputText);
    if (!mode) {
      return;
    }
    await persistDocumentTextLayoutMode(result.documentId, mode);
  }

  async function deleteWordMeaningEntry(word: string, entryId: string) {
    const key = normalizeWordKey(word);
    if (!key || !entryId) {
      return;
    }
    const nextMap = Object.fromEntries(
      Object.entries(wordMeaningMapFromSettings(state.settings)).map(([mapKey, entries]) => [mapKey, [...entries]]),
    ) as WordMeaningMap;
    const nextEntries = (nextMap[key] ?? []).filter((entry) => entry.id !== entryId);
    if (nextEntries.length) {
      nextMap[key] = nextEntries;
    } else {
      delete nextMap[key];
    }
    await persistWordMeaningMap(nextMap);
  }

  async function saveOnlineDictionaryMeanings(documentId: string, terms: string[], baseMap?: WordMeaningMap) {
    const document = state.documents.find((item) => item.id === documentId) ?? activeDocument;
    const nextMap = Object.fromEntries(
      Object.entries(baseMap ?? wordMeaningMapFromSettings(state.settings)).map(([key, entries]) => [key, [...entries]]),
    ) as WordMeaningMap;
    const cache = onlineDictionaryCacheFromSettings(state.settings);
    const lookupTerms = [...new Set(terms.map(normalizeWordKey))]
      .filter((term) => term && !term.includes(" ") && !hasUsableWordMeaning(nextMap[term]))
      .slice(0, onlineDictionaryBatchLimit);
    const unresolved = lookupTerms.filter(
      (term) =>
        cache[term]?.parserVersion !== onlineDictionaryParserVersion ||
        !normalizeOnlineDictionaryMeaning(cache[term]?.meaning ?? ""),
    );
    let cacheChanged = false;
    if (unresolved.length > 0) {
      const fetched = await mapWithConcurrency(unresolved, 6, async (term) => ({
        term,
        meaning: normalizeOnlineDictionaryMeaning(await fetchOnlineDictionaryMeaning(term)),
      }));
      for (const item of fetched) {
        cache[item.term] = {
          meaning: item.meaning,
          source: onlineDictionarySourceLabel,
          fetchedAt: nowIso(),
          parserVersion: onlineDictionaryParserVersion,
        };
        cacheChanged = true;
      }
    }
    for (const term of lookupTerms) {
      const cached = cache[term];
      if (!cached) {
        continue;
      }
      const meaning = normalizeOnlineDictionaryMeaning(cached.meaning);
      if (cached.meaning !== meaning) {
        cached.meaning = meaning;
        cached.source = onlineDictionarySourceLabel;
        cached.parserVersion = onlineDictionaryParserVersion;
        cacheChanged = true;
      }
    }
    if (cacheChanged) {
      const cacheValue = JSON.stringify(cache);
      patchState((draft) => {
        draft.settings[onlineDictionaryCacheSettingKey] = cacheValue;
      });
      await setSetting(onlineDictionaryCacheSettingKey, cacheValue);
    }
    let added = 0;
    for (const term of lookupTerms) {
      const cached = cache[term];
      const meaning = normalizeOnlineDictionaryMeaning(cached?.meaning ?? "");
      if (!meaning) {
        continue;
      }
      const entries = nextMap[term] ?? [];
      const duplicate = entries.some(
        (entry) =>
          entry.source === "dictionary" &&
          normalizeComparable(entry.meaning) === normalizeComparable(meaning),
      );
      if (duplicate) {
        continue;
      }
      entries.push({
        id: makeId("wm"),
        word: term,
        meaning,
        documentId,
        documentTitle: document?.title || document?.fileName || ui.untitledPaper,
        context: cached.source || onlineDictionarySourceLabel,
        createdAt: nowIso(),
        source: "dictionary",
      });
      nextMap[term] = entries;
      added += 1;
    }
    if (added > 0) {
      await persistWordMeaningMap(nextMap);
    }
    return { added, map: nextMap };
  }

  async function saveFallbackDictionaryMeanings(documentId: string, terms: string[], baseMap?: WordMeaningMap) {
    const document = state.documents.find((item) => item.id === documentId) ?? activeDocument;
    const nextMap = Object.fromEntries(
      Object.entries(baseMap ?? wordMeaningMapFromSettings(state.settings)).map(([key, entries]) => [key, [...entries]]),
    ) as WordMeaningMap;
    let added = 0;
    for (const term of terms) {
      const key = normalizeWordKey(term);
      const meaning = basicDictionaryMeaning(key);
      if (!key || !meaning || hasUsableWordMeaning(nextMap[key])) {
        continue;
      }
      const entries = nextMap[key] ?? [];
      const duplicate = entries.some(
        (entry) =>
          entry.source === "local" &&
          normalizeComparable(entry.meaning) === normalizeComparable(meaning) &&
          normalizeComparable(entry.context) === normalizeComparable("basic dictionary"),
      );
      if (duplicate) {
        continue;
      }
      entries.push({
        id: makeId("wm"),
        word: key,
        meaning,
        documentId,
        documentTitle: document?.title || document?.fileName || ui.untitledPaper,
        context: "offline fallback dictionary",
        createdAt: nowIso(),
        source: "local",
      });
      nextMap[key] = entries;
      added += 1;
    }
    if (added > 0) {
      await persistWordMeaningMap(nextMap);
    }
    return { added, map: nextMap };
  }

  async function queueMissingWordMeanings() {
    if (!activeDocument) {
      showToast(ui.openDocumentFirst);
      return;
    }
    const pages = activePages.length ? activePages : await ensureActivePages();
    if (pages.length === 0 || pages.every((page) => !page.text.trim())) {
      showToast(ui.wordMeaningNoText);
      return;
    }
    const candidates = extractDocumentTermCandidates(pages, activeDocument);
    const terms = candidates.map((candidate) => candidate.term);
    const storedTerms = terms.length ? await persistWordListForPages(activeDocument.id, pages) : activeDocumentWordList;
    if (storedTerms.length === 0) {
      showToast(ui.wordMeaningNoText);
      return;
    }
    const currentMap = wordMeaningMapFromSettings(state.settings);
    const missingCandidates = candidates
      .filter((candidate) => {
        if (!candidate.contextNeeded) {
          return false;
        }
        const entries = currentMap[normalizeWordKey(candidate.term)] ?? [];
        return !entries.some((entry) => entry.source === "ai" && entry.documentId === activeDocument.id);
      })
      .sort((a, b) => b.score - a.score || b.count - a.count || a.term.localeCompare(b.term));
    const missingTerms = missingCandidates.slice(0, wordMeaningBatchLimit).map((candidate) => candidate.term);
    if (missingTerms.length === 0) {
      showToast(ui.wordMeaningNoMissing);
      return;
    }
    void saveFallbackDictionaryMeanings(activeDocument.id, missingTerms)
      .then((fallback) => saveOnlineDictionaryMeanings(activeDocument.id, missingTerms, fallback.map))
      .catch((error) => showToast(`${ui.aiTaskFailedPrefix}: ${String(error)}`, "error"));
    const queued = await queueTask(
      wordMeaningTaskType,
      {
        mode: "initial",
        words: missingTerms,
        candidateTerms: missingCandidates.slice(0, wordMeaningBatchLimit),
        pages,
      },
      { keepPanel: true },
    );
    if (!queued) {
      return;
    }
    if (queued.status === "pending") {
      showToast(
        uiLanguage === "ko"
          ? `단어 뜻 생성 중: 요청 ${missingTerms.length}개 / 전체 후보 ${storedTerms.length}개`
          : `Building word meanings: requested ${missingTerms.length} / total candidates ${storedTerms.length}`,
      );
      return;
    } else {
      await saveWordMeaningsFromResult(queued, missingTerms);
    }
  }

  async function queueAdjustedWordMeaning(popup: WordPopup) {
    if (!activeDocument) {
      showToast(ui.openDocumentFirst);
      return;
    }
    const word = normalizeWordKey(popup.word);
    if (!word) {
      return;
    }
    const pages = activePages.length ? activePages : await ensureActivePages();
    const page = pages.find((item) => item.pageNumber === popup.page);
    const existingMeanings = (wordMeaningMap[normalizeWordKey(word)] ?? []).map((entry) => ({
      meaning: entry.meaning,
      context: entry.context,
      documentTitle: entry.documentTitle,
    }));
    const queued = await queueTask(
      wordMeaningTaskType,
      {
        mode: "adjust",
        words: [word],
        page: popup.page,
        context: popup.context,
        existingMeanings,
        pages: page ? [page] : pages.slice(0, 3),
      },
      { keepPanel: true },
    );
    if (!queued) {
      return;
    }
    if (queued.status === "pending") {
      showToast(ui.wordMeaningAdjustQueued);
    } else {
      await saveWordMeaningsFromResult(queued, [word]);
    }
  }

  function openWordMeaningPopup(popup: WordPopup) {
    if (markupToolKind !== "none" || !wordMeaningLookupEnabled(state.settings)) {
      return;
    }
    const term = bestTermForWordPopup(popup, activeDocumentWordList, wordMeaningMap);
    setWordPopup({ ...popup, word: term });
    if (activeDocument && term && !term.includes(" ") && !hasUsableWordMeaning(wordMeaningMap[normalizeWordKey(term)])) {
      const key = normalizeWordKey(term);
      setWordLookupLoadingKey(key);
      void saveFallbackDictionaryMeanings(activeDocument.id, [term])
        .then((fallback) => saveOnlineDictionaryMeanings(activeDocument.id, [term], fallback.map))
        .catch((error) => showToast(`${ui.aiTaskFailedPrefix}: ${String(error)}`, "error"))
        .finally(() => setWordLookupLoadingKey((current) => (current === key ? null : current)));
    }
  }

  useEffect(() => {
    if (!wordPopup) {
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".word-meaning-popover")) {
        return;
      }
      setWordPopup(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [wordPopup]);

  return {
    wordPopup,
    setWordPopup,
    wordLookupLoadingKey,
    persistWordListForPages,
    saveWordMeaningsFromResult,
    saveDocumentLayoutFromResult,
    deleteWordMeaningEntry,
    queueMissingWordMeanings,
    queueAdjustedWordMeaning,
    openWordMeaningPopup,
  };
}
