import { useMemo } from "react";
import type { AiResultRecord, AppStateRecord } from "../types";
import { currentNote, documentPages } from "../lib/appState";
import { aiOutlineVersion, documentOutlineVersionSettingKey, readerOutlineRows, type OutlineAnchor, type OutlineRow } from "../lib/outlines";
import { horizontalScrollFromSettings, pageTextLayoutModesFromSettings } from "../lib/readerSettings";
import { translationLanguageNameFromSettings, uiLanguageFromSettings, uiStrings } from "../lib/uiStrings";
import { currentTranslationUnitsForSelection, selectedSourceSentenceIds } from "../lib/readerDerived";
import { extractDocumentTermCandidates, normalizeWordKey, parseStoredWordList, wordMeaningMapFromSettings } from "../lib/wordMeanings";

type ActiveDocumentDataInput = {
  state: AppStateRecord;
  activeDocumentId: string | null;
  pageCursor: number;
  selectedSentenceId: string | null;
  pageOutlineAnchors: Record<number, OutlineAnchor[]>;
  pdfOutlineRows: OutlineRow[];
  floatingResultId: string | null;
};

export function useActiveDocumentData(input: ActiveDocumentDataInput) {
  const activeDocument = useMemo(
    () => input.state.documents.find((document) => document.id === input.activeDocumentId) ?? null,
    [input.activeDocumentId, input.state.documents],
  );
  const activePages = useMemo(
    () => (activeDocument ? documentPages(input.state, activeDocument.id) : []),
    [activeDocument, input.state],
  );
  const activePageNumbers = useMemo(
    () =>
      activePages.length
        ? activePages.map((page) => page.pageNumber)
        : activeDocument?.pageCount
          ? Array.from({ length: activeDocument.pageCount }, (_, index) => index + 1)
          : [],
    [activeDocument?.pageCount, activePages],
  );
  const activePageTextLayoutModes = useMemo(
    () =>
      pageTextLayoutModesFromSettings(
        input.state.settings,
        input.activeDocumentId,
        activePageNumbers,
      ),
    [activePageNumbers, input.activeDocumentId, input.state.settings],
  );
  const currentPage = useMemo(
    () => activePages.find((page) => page.pageNumber === input.pageCursor),
    [activePages, input.pageCursor],
  );
  const wordMeaningMap = useMemo(() => wordMeaningMapFromSettings(input.state.settings), [input.state.settings]);
  const activeDocumentWordList = useMemo(() => {
    if (!activeDocument) {
      return [];
    }
    const stored = parseStoredWordList(input.state.settings, activeDocument.id);
    return stored.length ? stored : extractDocumentTermCandidates(activePages, activeDocument).map((candidate) => candidate.term);
  }, [activeDocument, activePages, input.state.settings]);
  const missingWordCount = useMemo(
    () => activeDocumentWordList.filter((word) => !wordMeaningMap[normalizeWordKey(word)]?.length).length,
    [activeDocumentWordList, wordMeaningMap],
  );
  const activeAnnotations = useMemo(
    () => input.state.annotations.filter((item) => item.documentId === input.activeDocumentId),
    [input.activeDocumentId, input.state.annotations],
  );
  const activeAiResults = useMemo(
    () => input.state.aiResults.filter((item) => item.documentId === input.activeDocumentId),
    [input.activeDocumentId, input.state.aiResults],
  );
  const activeDetectedOutlineAnchors = useMemo(
    () =>
      Object.values(input.pageOutlineAnchors)
        .flat()
        .sort((a, b) => a.page - b.page || a.top - b.top),
    [input.pageOutlineAnchors],
  );
  const uiLanguage = uiLanguageFromSettings(input.state.settings);
  const ui = uiStrings[uiLanguage];
  const translationLanguageName = translationLanguageNameFromSettings(input.state.settings);
  const currentTranslationUnits = useMemo(
    () => currentTranslationUnitsForSelection(currentPage, activeAiResults, translationLanguageName),
    [activeAiResults, currentPage, translationLanguageName],
  );
  const selectedSentenceIds = useMemo(
    () => selectedSourceSentenceIds(currentTranslationUnits, input.selectedSentenceId),
    [currentTranslationUnits, input.selectedSentenceId],
  );
  const activeOutlineRows = useMemo(() => {
    const outlineVersionCurrent = input.activeDocumentId
      ? input.state.settings[documentOutlineVersionSettingKey(input.activeDocumentId)] === aiOutlineVersion
      : false;
    const outlineResults = outlineVersionCurrent
      ? activeAiResults
      : activeAiResults.filter((result: AiResultRecord) => result.taskType.toString() !== "outlineDocument");
    return readerOutlineRows(outlineResults, input.pdfOutlineRows, activePages, activeDetectedOutlineAnchors, ui);
  }, [activeAiResults, input.activeDocumentId, input.pdfOutlineRows, activePages, activeDetectedOutlineAnchors, input.state.settings, ui]);
  const activeCitations = useMemo(
    () => input.state.citationCards.filter((item) => item.documentId === input.activeDocumentId),
    [input.activeDocumentId, input.state.citationCards],
  );
  const activeNote = useMemo(
    () => (activeDocument ? currentNote(input.state, activeDocument.id) : null),
    [activeDocument, input.state],
  );
  const floatingResult = useMemo(
    () => activeAiResults.find((result) => result.id === input.floatingResultId) ?? null,
    [activeAiResults, input.floatingResultId],
  );
  const bridgePath = input.state.settings.bridgePath || "bridge";
  const savedHorizontalScrollLeft = horizontalScrollFromSettings(input.state.settings, input.activeDocumentId);

  return {
    activeDocument,
    activePages,
    activePageTextLayoutModes,
    currentPage,
    wordMeaningMap,
    activeDocumentWordList,
    missingWordCount,
    activeAnnotations,
    activeAiResults,
    activeDetectedOutlineAnchors,
    uiLanguage,
    ui,
    translationLanguageName,
    currentTranslationUnits,
    selectedSentenceIds,
    activeOutlineRows,
    activeCitations,
    activeNote,
    floatingResult,
    bridgePath,
    savedHorizontalScrollLeft,
  };
}
