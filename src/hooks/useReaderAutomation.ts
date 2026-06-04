import { useEffect } from "react";
import type { AiResultRecord, AiTaskType, AppStateRecord, DocumentRecord, PageRecord } from "../types";
import type { PdfDocumentProxy } from "../lib/pdfDocument";
import { normalizeAiProviderKind } from "../lib/ai";
import { aiOutlineVersion, documentOutlineVersionSettingKey, hasFreshPendingOutlineResult, outlinePagesForAi, parseAiOutlineRows } from "../lib/outlines";
import {
  pageTextLayoutConfidenceFromSettings,
  pageTextLayoutAiVersion,
  pageTextLayoutAiVersionSettingKey,
  pageTextLayoutModeFromSettings,
  pageTextLayoutSourceSettingKey,
} from "../lib/readerSettings";
import {
  hasCompleteTranslationResultForPage,
  hasTranslationRequestForPage,
  isPageFullyTranslated,
  pendingTranslationResultForPage,
  translationRequestKey,
} from "../lib/translations";
import { setSetting } from "../lib/tauri";
import type { SelectionToolbar } from "../lib/pdfText";
import type { WordPopup } from "../lib/wordMeanings";
import { translationLanguageNameFromSettings } from "../lib/uiStrings";

type PatchState = (mutator: (draft: AppStateRecord) => void) => void;

type QueueTask = (
  taskType: AiTaskType,
  payload: Record<string, unknown>,
  options?: { silent?: boolean; keepPanel?: boolean },
) => Promise<AiResultRecord | null>;

type ReaderAutomationInput = {
  state: AppStateRecord;
  activeDocument: DocumentRecord | null;
  activeDocumentId: string | null;
  pdfDocument: PdfDocumentProxy | null;
  activePages: PageRecord[];
  activeAiResults: AiResultRecord[];
  activeAnnotations: unknown[];
  pageCursor: number;
  translationEligiblePages: Set<number>;
  incompleteTranslationRetriesRef: { current: Map<string, number> };
  outlineRequestsRef: { current: Set<string> };
  documentLayoutRequestsRef: { current: Set<string> };
  setSelectedSentenceId: (id: string | null | ((current: string | null) => string | null)) => void;
  setWordPopup: (popup: WordPopup | null) => void;
  setSelectionToolbar: (toolbar: SelectionToolbar | null) => void;
  setTextSelectionPreview: (preview: null) => void;
  setTranslationEligiblePages: (pages: Set<number>) => void;
  queueTranslationForPage: (page: PageRecord, options?: { silent?: boolean; force?: boolean }) => Promise<AiResultRecord | null>;
  queueTask: QueueTask;
  extractOrderedPagesFromPdf: (document: DocumentRecord, pdf: PdfDocumentProxy) => Promise<PageRecord[]>;
  replaceExtractedPages: (documentId: string, pages: PageRecord[]) => Promise<void>;
  saveDocumentLayoutFromResult: (result: AiResultRecord) => Promise<void>;
  runAutoHighlightForCurrentPage: (options?: { silent?: boolean; force?: boolean }) => Promise<void>;
  patchState: PatchState;
  agentParallelTaskLimit: number;
};

export function useReaderAutomation(input: ReaderAutomationInput) {
  const {
    state,
    activeDocument,
    activeDocumentId,
    pdfDocument,
    activePages,
    activeAiResults,
    activeAnnotations,
    pageCursor,
    translationEligiblePages,
    incompleteTranslationRetriesRef,
    outlineRequestsRef,
    documentLayoutRequestsRef,
    setSelectedSentenceId,
    setWordPopup,
    setSelectionToolbar,
    setTextSelectionPreview,
    setTranslationEligiblePages,
    queueTranslationForPage,
    queueTask,
    extractOrderedPagesFromPdf,
    replaceExtractedPages,
    saveDocumentLayoutFromResult,
    runAutoHighlightForCurrentPage,
    patchState,
    agentParallelTaskLimit,
  } = input;
  useEffect(() => {
    setSelectedSentenceId(null);
    setWordPopup(null);
    setSelectionToolbar(null);
    setTextSelectionPreview(null);
    setTranslationEligiblePages(new Set([1]));
  }, [activeDocumentId]);

  useEffect(() => {
    setSelectedSentenceId((current) => {
      const selectedPage = Number(current?.match(/^p(\d+)-(?:s|ai)\d+$/)?.[1] ?? 0);
      return selectedPage === pageCursor ? current : null;
    });
  }, [pageCursor]);

  useEffect(() => {
    if (state.settings.autoTranslate !== "true" || !activeDocument || !pdfDocument) {
      return;
    }
    const documentId = activeDocument.id;
    let cancelled = false;
    async function queueNextPage() {
      if (cancelled || activePages.length === 0) {
        return;
      }
      const pages = activePages;
      const providerKind = normalizeAiProviderKind(state.settings.aiProvider);
      const targetLanguage = translationLanguageNameFromSettings(state.settings);
      const pendingCount = pages.filter((page) => pendingTranslationResultForPage(activeAiResults, page, targetLanguage)).length;
      const queueLimit = providerKind === "local-draft" ? pages.length : agentParallelTaskLimit;
      const capacity = Math.max(0, queueLimit - pendingCount);
      if (capacity === 0) {
        return;
      }
      const candidates = pages
        .filter((page) => page.text.length >= 12 && translationEligiblePages.has(page.pageNumber))
        .sort((a, b) => a.pageNumber - b.pageNumber)
        .flatMap((page) => {
          if (!hasTranslationRequestForPage(activeAiResults, page, targetLanguage)) {
            return [{ page, force: false }];
          }
          if (
            normalizeAiProviderKind(state.settings.aiProvider) !== "local-draft" &&
            hasCompleteTranslationResultForPage(activeAiResults, page, targetLanguage) &&
            !isPageFullyTranslated(page, activeAiResults, targetLanguage) &&
            !pendingTranslationResultForPage(activeAiResults, page, targetLanguage)
          ) {
            const retryKey = translationRequestKey(documentId, page.pageNumber, page.text, targetLanguage);
            const retryCount = incompleteTranslationRetriesRef.current.get(retryKey) ?? 0;
            if (retryCount < 1) {
              incompleteTranslationRetriesRef.current.set(retryKey, retryCount + 1);
              return [{ page, force: true }];
            }
          }
          return [];
        })
        .slice(0, capacity);
      if (cancelled) {
        return;
      }
      await Promise.all(candidates.map((candidate) => queueTranslationForPage(candidate.page, { silent: true, force: candidate.force })));
    }
    void queueNextPage();
    return () => {
      cancelled = true;
    };
  }, [state.settings.autoTranslate, state.settings.aiProvider, state.settings.translationLanguage, activeDocument?.id, activeDocument?.pageCount, pdfDocument, activePages.length, activeAiResults, translationEligiblePages]);

  useEffect(() => {
    if (!activeDocument || !pdfDocument) {
      return;
    }
    const outlineVersionCurrent = state.settings[documentOutlineVersionSettingKey(activeDocument.id)] === aiOutlineVersion;
    const hasUsableAiOutline = outlineVersionCurrent && parseAiOutlineRows(activeAiResults, activePages).length > 0;
    const hasBlockingPendingOutline = outlineVersionCurrent && hasFreshPendingOutlineResult(activeAiResults);
    if (hasUsableAiOutline || hasBlockingPendingOutline || outlineRequestsRef.current.has(activeDocument.id)) {
      return;
    }
    const document = activeDocument;
    const documentId = document.id;
    const pdf = pdfDocument;
    const pdfPageCount = pdf.numPages;
    let cancelled = false;
    outlineRequestsRef.current.add(documentId);
    async function queueInitialAiOutline() {
      const expectedPages = Math.max(1, document.pageCount || pdfPageCount || activePages.length || 1);
      const cachedPagesReady =
        activePages.length >= expectedPages &&
        activePages.filter((page) => page.text.trim().length > 0).length >= Math.max(1, Math.floor(expectedPages * 0.8));
      const pages = cachedPagesReady ? activePages : await extractOrderedPagesFromPdf(document, pdf);
      if (cancelled) {
        return;
      }
      if (!cachedPagesReady) {
        await replaceExtractedPages(documentId, pages);
      }
      const outlinePages = outlinePagesForAi(pages, expectedPages);
      if (outlinePages.length === 0) {
        outlineRequestsRef.current.delete(documentId);
        return;
      }
      const queued = await queueTask("outlineDocument", { pages: outlinePages }, { silent: true, keepPanel: true });
      if (!queued) {
        outlineRequestsRef.current.delete(documentId);
      } else {
        patchState((draft) => {
          draft.settings[documentOutlineVersionSettingKey(documentId)] = aiOutlineVersion;
        });
        await setSetting(documentOutlineVersionSettingKey(documentId), aiOutlineVersion);
      }
    }
    void queueInitialAiOutline();
    return () => {
      cancelled = true;
    };
  }, [activeDocument?.id, activeDocument?.pageCount, pdfDocument, activePages.length, activeAiResults, state.settings]);

  useEffect(() => {
    if (!activeDocument || activePages.length === 0 || normalizeAiProviderKind(state.settings.aiProvider) === "local-draft") {
      return;
    }
    const documentId = activeDocument.id;
    const versionKey = pageTextLayoutAiVersionSettingKey(documentId);
    const versionCurrent = state.settings[versionKey] === pageTextLayoutAiVersion;
    const hasPendingLayout = activeAiResults.some(
      (result) => result.taskType.toString() === "classifyDocumentLayout" && result.status === "pending",
    );
    if (versionCurrent || hasPendingLayout || documentLayoutRequestsRef.current.has(documentId)) {
      return;
    }
    const layoutCandidates = activePages
      .map((page) => {
        const mode = pageTextLayoutModeFromSettings(state.settings, documentId, page.pageNumber);
        const confidence = pageTextLayoutConfidenceFromSettings(state.settings, documentId, page.pageNumber);
        const source = state.settings[pageTextLayoutSourceSettingKey(documentId, page.pageNumber)] || "";
        return {
          page: page.pageNumber,
          mode: mode || "unknown",
          confidence,
          reason: source === "ai" ? "already AI-classified" : "local geometry confidence below threshold",
          pageRecord: page,
          source,
        };
      })
      .filter((candidate) => candidate.source !== "ai" && (candidate.mode === "unknown" || candidate.confidence < 0.7))
      .slice(0, 8);
    if (layoutCandidates.length === 0) {
      patchState((draft) => {
        draft.settings[versionKey] = pageTextLayoutAiVersion;
      });
      void setSetting(versionKey, pageTextLayoutAiVersion);
      return;
    }
    let cancelled = false;
    documentLayoutRequestsRef.current.add(documentId);
    async function queueInitialLayoutClassification() {
      const samplePages = layoutCandidates
        .map((candidate) => candidate.pageRecord)
        .filter((page) => page.text.trim().length > 80);
      if (samplePages.length === 0 || cancelled) {
        documentLayoutRequestsRef.current.delete(documentId);
        return;
      }
      const queued = await queueTask(
        "classifyDocumentLayout",
        {
          pages: samplePages,
          layoutCandidates: layoutCandidates.map(({ pageRecord, ...candidate }) => candidate),
        },
        { silent: true, keepPanel: true },
      );
      if (cancelled) {
        return;
      }
      if (!queued) {
        documentLayoutRequestsRef.current.delete(documentId);
        return;
      }
      patchState((draft) => {
        draft.settings[versionKey] = pageTextLayoutAiVersion;
      });
      await setSetting(versionKey, pageTextLayoutAiVersion);
      if (queued.status !== "pending") {
        await saveDocumentLayoutFromResult(queued);
      }
    }
    void queueInitialLayoutClassification();
    return () => {
      cancelled = true;
    };
  }, [activeDocument?.id, activePages.length, activeAiResults, state.settings.aiProvider, state.settings]);

  useEffect(() => {
    if (state.settings.autoHighlight !== "true" || !activeDocument || !pdfDocument) {
      return;
    }
    void runAutoHighlightForCurrentPage({ silent: true });
  }, [state.settings.autoHighlight, activeDocument?.id, pdfDocument, pageCursor, activePages.length, activeAiResults, activeAnnotations]);

}
