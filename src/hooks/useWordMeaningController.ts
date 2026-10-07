import { useEffect, useRef, useState } from "react";
import type { AiResultRecord, AppStateRecord, DocumentRecord, PageRecord } from "../types";
import { makeId, nowIso } from "../lib/ids";
import { wordMeaningLookupEnabled } from "../lib/appState";
import {
  pageTextLayoutConfidenceSettingKey,
  pageTextLayoutSettingKey,
  pageTextLayoutSourceSettingKey,
  parsePageTextLayoutModes,
} from "../lib/readerSettings";
import { generateLocalWordMeaning, setSetting } from "../lib/tauri";
import { normalizeComparable } from "../lib/textUtils";
import type { UiLanguage, UiStrings } from "../lib/uiStrings";
import { wordMeaningTaskType } from "../lib/aiResults";
import {
  bestTermForWordPopup,
  displayWordMeaning,
  documentWordListSettingKey,
  extractDocumentTermCandidates,
  hasUsableWordMeaning,
  hasWordMeaningForContext,
  normalizeWordKey,
  parseWordMeaningItems,
  requestedWordMeaningTerms,
  wordMeaningBatchLimit,
  wordMeaningMapSettingKey,
  wordClickCountsFromSettings,
  wordClickCountsSettingKey,
  type WordMeaningMap,
  type WordPopup,
} from "../lib/wordMeanings";

type PatchState = (mutator: (draft: AppStateRecord) => void) => void;

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
  ensureActivePages: () => Promise<PageRecord[]>;
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
    ensureActivePages,
  } = input;
  const [wordPopup, setWordPopup] = useState<WordPopup | null>(null);
  const [wordLookupLoadingKey, setWordLookupLoadingKey] = useState<string | null>(null);
  const [wordLookupError, setWordLookupError] = useState<string | null>(null);
  const meaningMapRef = useRef(wordMeaningMap);
  const clickCountsRef = useRef(wordClickCountsFromSettings(state.settings));
  const meaningSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const clickSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => { meaningMapRef.current = wordMeaningMap; }, [wordMeaningMap]);
  useEffect(() => { clickCountsRef.current = wordClickCountsFromSettings(state.settings); }, [state.settings]);
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
    const nextMap = Object.fromEntries(
      Object.entries(meaningMapRef.current).map(([key, entries]) => [key, [...entries]]),
    ) as WordMeaningMap;
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
          normalizeComparable(entry.meaning) === normalizeComparable(meaning),
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
    await persistWordMeaningMap(nextMap);
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
    meaningMapRef.current = nextMap;
    const value = JSON.stringify(nextMap);
    patchState((draft) => {
      draft.settings[wordMeaningMapSettingKey] = value;
    });
    const save = meaningSaveChainRef.current.catch(() => undefined).then(() => setSetting(wordMeaningMapSettingKey, value));
    meaningSaveChainRef.current = save;
    await save;
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
      return;
    }
  }

  async function deleteWordMeaningEntry(word: string, entryId: string) {
    const key = normalizeWordKey(word);
    if (!key || !entryId) {
      return;
    }
    const nextMap = Object.fromEntries(
      Object.entries(meaningMapRef.current).map(([mapKey, entries]) => [mapKey, [...entries]]),
    ) as WordMeaningMap;
    const nextEntries = (nextMap[key] ?? []).filter((entry) => entry.id !== entryId);
    if (nextEntries.length) {
      nextMap[key] = nextEntries;
    } else {
      delete nextMap[key];
    }
    await persistWordMeaningMap(nextMap);
  }

  async function createLocalMeaning(documentId: string, term: string, sentence: string, allowExisting: boolean) {
    const key = normalizeWordKey(term);
    const sourceSentence = sentence.trim();
    if (!key || !sourceSentence) {
      throw new Error(uiLanguage === "ko" ? "단어가 포함된 문장을 찾지 못했습니다." : "Could not find the sentence containing this word.");
    }
    if (!allowExisting && hasUsableWordMeaning(meaningMapRef.current[key])) return false;
    const existingMeanings = [...new Set((meaningMapRef.current[key] ?? []).map(displayWordMeaning).filter(Boolean))];
    const explainSimply = allowExisting && hasWordMeaningForContext(meaningMapRef.current[key], documentId, sourceSentence);
    const meaning = (await generateLocalWordMeaning(key, sourceSentence, existingMeanings, explainSimply)).trim();
    const nextMap = Object.fromEntries(
      Object.entries(meaningMapRef.current).map(([mapKey, entries]) => [mapKey, [...entries]]),
    ) as WordMeaningMap;
    if (!allowExisting && hasUsableWordMeaning(nextMap[key])) return false;
    const entries = nextMap[key] ?? [];
    if (entries.some((entry) =>
      normalizeComparable(displayWordMeaning(entry)) === normalizeComparable(meaning)
      && (!allowExisting || hasWordMeaningForContext([entry], documentId, sourceSentence)),
    )) return false;
    const paper = state.documents.find((item) => item.id === documentId) ?? activeDocument;
    entries.push({
      id: makeId("wm"),
      word: key,
      meaning,
      documentId,
      documentTitle: paper?.title || paper?.fileName || ui.untitledPaper,
      context: sourceSentence,
      createdAt: nowIso(),
      source: "local-llm",
    });
    nextMap[key] = entries;
    await persistWordMeaningMap(nextMap);
    return true;
  }

  async function requestLocalMeaning(documentId: string, term: string, sentence: string, allowExisting: boolean) {
    const key = normalizeWordKey(term);
    setWordLookupLoadingKey(key);
    setWordLookupError(null);
    try {
      const created = await createLocalMeaning(documentId, term, sentence, allowExisting);
      if (allowExisting && !created) {
        showToast(uiLanguage === "ko" ? "같은 단어 뜻이 이미 저장되어 있습니다." : "That meaning is already saved.");
      }
    } catch (error) {
      const message = String(error);
      setWordLookupError(message);
      showToast(message, "error");
    } finally {
      setWordLookupLoadingKey((current) => current === key ? null : current);
    }
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
    await persistWordListForPages(activeDocument.id, pages);
    const missing = candidates.filter((candidate) => candidate.examples.length > 0 && !hasUsableWordMeaning(meaningMapRef.current[normalizeWordKey(candidate.term)]))
      .slice(0, 20);
    if (missing.length === 0) {
      showToast(ui.wordMeaningNoMissing);
      return;
    }
    setWordLookupLoadingKey("batch");
    let created = 0;
    try {
      for (const candidate of missing) {
        try {
          if (await createLocalMeaning(activeDocument.id, candidate.term, candidate.examples[0], false)) created += 1;
        } catch (error) {
          showToast(String(error), "error");
          break;
        }
      }
      showToast(uiLanguage === "ko" ? `로컬 단어 뜻 ${created}개 저장` : `Saved ${created} local word meanings`);
    } finally {
      setWordLookupLoadingKey(null);
    }
  }

  async function queueAdjustedWordMeaning(popup: WordPopup) {
    if (!activeDocument) {
      showToast(ui.openDocumentFirst);
      return;
    }
    await requestLocalMeaning(activeDocument.id, popup.word, popup.context, true);
  }

  function openWordMeaningPopup(popup: WordPopup) {
    if (markupToolKind !== "none" || !wordMeaningLookupEnabled(state.settings)) return;
    const term = bestTermForWordPopup(popup, activeDocumentWordList, meaningMapRef.current);
    showMeaningPopup({ ...popup, word: term });
  }

  function openSelectedMeaningPopup(popup: WordPopup) {
    showMeaningPopup(popup);
  }

  function showMeaningPopup(popup: WordPopup) {
    const term = popup.word;
    const key = normalizeWordKey(term);
    setWordPopup(popup);
    setWordLookupError(null);
    if (!key) return;
    const counts = { ...clickCountsRef.current, [key]: (clickCountsRef.current[key] ?? 0) + 1 };
    clickCountsRef.current = counts;
    const value = JSON.stringify(counts);
    patchState((draft) => { draft.settings[wordClickCountsSettingKey] = value; });
    const save = clickSaveChainRef.current.catch(() => undefined).then(() => setSetting(wordClickCountsSettingKey, value));
    clickSaveChainRef.current = save;
    void save.catch((error) => showToast(String(error), "error"));
    if (activeDocument && !hasUsableWordMeaning(meaningMapRef.current[key])) {
      void requestLocalMeaning(activeDocument.id, term, popup.context, false);
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
    wordLookupError,
    persistWordListForPages,
    saveWordMeaningsFromResult,
    saveDocumentLayoutFromResult,
    deleteWordMeaningEntry,
    queueMissingWordMeanings,
    queueAdjustedWordMeaning,
    openWordMeaningPopup,
    openSelectedMeaningPopup,
  };
}
