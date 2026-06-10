import { useEffect } from "react";
import type { AiResultRecord, AiTaskType, AnnotationRecord, AppStateRecord, DocumentRecord, PageRecord } from "../types";
import { createAutoHighlights } from "../lib/highlights";
import { annotationKey } from "../lib/annotationHelpers";
import { autoHighlightRequestKey, hasAutoHighlightRequestForPage, stalePendingTranslationMs } from "../lib/translations";
import { savePages, upsertAnnotation } from "../lib/tauri";
import type { UiLanguage, UiStrings } from "../lib/uiStrings";

type PatchState = (mutator: (draft: AppStateRecord) => void) => void;

type QueueTask = (
  taskType: AiTaskType,
  payload: Record<string, unknown>,
  options?: { silent?: boolean; keepPanel?: boolean },
) => Promise<AiResultRecord | null>;

type PagePersistenceInput = {
  state: AppStateRecord;
  activeDocument: DocumentRecord | null;
  activePages: PageRecord[];
  activeAnnotations: AnnotationRecord[];
  activeAiResults: AiResultRecord[];
  pageCursor: number;
  translationEligiblePages: Set<number>;
  autoHighlightRequestsRef: { current: Map<string, number> };
  ui: UiStrings;
  uiLanguage: UiLanguage;
  patchState: PatchState;
  setState: (updater: (current: AppStateRecord) => AppStateRecord) => void;
  showToast: (message: string, kind?: "info" | "error") => void;
  setPageImages: (updater: (current: Record<number, string>) => Record<number, string>) => void;
  queueTranslationForPage: (page: PageRecord, options?: { silent?: boolean; force?: boolean }) => Promise<AiResultRecord | null>;
  persistWordListForPages: (documentId: string, pages: PageRecord[]) => Promise<string[]>;
  ensureActivePages: () => Promise<PageRecord[]>;
  queueTask: QueueTask;
};

export function usePagePersistence(input: PagePersistenceInput) {
  const {
    state,
    activeDocument,
    activePages,
    activeAnnotations,
    activeAiResults,
    pageCursor,
    translationEligiblePages,
    autoHighlightRequestsRef,
    ui,
    uiLanguage,
    patchState,
    setState,
    showToast,
    setPageImages,
    queueTranslationForPage,
    persistWordListForPages,
    ensureActivePages,
    queueTask,
  } = input;
  async function createPageText(page: PageRecord) {
    setState((current) => {
      const existing = current.pages.find(
        (item) => item.documentId === page.documentId && item.pageNumber === page.pageNumber,
      );
      if (
        existing &&
        existing.text === page.text &&
        existing.outlineLabel === page.outlineLabel
      ) {
        return current;
      }
      const pages = current.pages
        .filter((item) => !(item.documentId === page.documentId && item.pageNumber === page.pageNumber))
        .concat(page);
      return { ...current, pages };
    });
    if (state.settings.autoTranslate === "true" && translationEligiblePages.has(page.pageNumber)) {
      void queueTranslationForPage(page, { silent: true });
    }
    const pagesForWords = activePages
      .filter((item) => !(item.documentId === page.documentId && item.pageNumber === page.pageNumber))
      .concat(page)
      .sort((a, b) => a.pageNumber - b.pageNumber);
    void persistWordListForPages(page.documentId, pagesForWords).catch((error) =>
      showToast(`${ui.aiTaskFailedPrefix}: ${String(error)}`, "error"),
    );
  }

  function rememberPageImage(pageNumber: number, image: string) {
    setPageImages((current) => {
      if (current[pageNumber] === image) {
        return current;
      }
      return { ...current, [pageNumber]: image };
    });
  }

  useEffect(() => {
    if (!activeDocument || activePages.length === 0 || activePages.length < activeDocument.pageCount) {
      return;
    }
    const pages = activePages.map((page) => ({ ...page, documentId: activeDocument.id }));
    void savePages(activeDocument.id, pages).catch((error) => showToast(`${ui.couldNotSavePageTextPrefix}: ${String(error)}`, "error"));
  }, [activeDocument?.id, activeDocument?.pageCount, activePages.length]);

  async function runAutoHighlightForCurrentPage(options: { silent?: boolean; force?: boolean } = {}) {
    if (!activeDocument) {
      return;
    }
    const pages = activePages.length ? activePages : await ensureActivePages();
    const page = pages.find((item) => item.pageNumber === pageCursor);
    if (!page || page.text.length < 12) {
      if (!options.silent) {
        showToast(ui.noExtractableTextCurrentPage);
      }
      return;
    }
    const requestKey = autoHighlightRequestKey(activeDocument.id, page.pageNumber, page.text);
    const queuedAt = autoHighlightRequestsRef.current.get(requestKey);
    const hasRecentRequest = Boolean(queuedAt && Date.now() - queuedAt < stalePendingTranslationMs);
    if (!options.force && options.silent && hasRecentRequest) {
      return;
    }
    const shouldQueueAgent =
      options.force || (!hasRecentRequest && !hasAutoHighlightRequestForPage(activeAiResults, page));
    if (shouldQueueAgent) {
      autoHighlightRequestsRef.current.set(requestKey, Date.now());
      await queueTask("autoHighlight", { page: page.pageNumber, pages: [page] }, { silent: true, keepPanel: true });
    }
    const existing = new Set(activeAnnotations.map(annotationKey));
    const generated = createAutoHighlights(activeDocument.id, [page]).filter((annotation) => {
      const key = annotationKey(annotation);
      if (existing.has(key)) {
        return false;
      }
      existing.add(key);
      return true;
    });
    for (const annotation of generated) {
      const saved = await upsertAnnotation(annotation);
      patchState((draft) => {
        draft.annotations = [saved, ...draft.annotations.filter((item) => item.id !== saved.id)];
      });
    }
    if (!options.silent) {
      if (generated.length === 0 && !shouldQueueAgent) {
        showToast(ui.autoHighlightAlreadyQueued);
      } else if (generated.length === 0) {
        showToast(ui.queuedAutoHighlightCurrentPage);
      } else {
        showToast(`${generated.length}${uiLanguage === "ko" ? "" : " "}${ui.highlightedLocalCandidatesSuffix}`);
      }
    }
  }

  return {
    createPageText,
    rememberPageImage,
    runAutoHighlightForCurrentPage,
  };
}
