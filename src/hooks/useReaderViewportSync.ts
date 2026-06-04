import { useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { outlineAnchorDomId, type OutlineAnchor, type OutlineRow } from "../lib/outlines";
import { clampNumber, documentHorizontalScrollSettingKey, nextPageTranslationReadProgress, type ReaderBookmark } from "../lib/readerSettings";
import { setSetting } from "../lib/tauri";
import type { PdfDocumentProxy } from "../lib/pdfDocument";
import type { AppStateRecord, DocumentRecord, PageRecord, WorkspaceMode } from "../types";

type PatchState = (mutator: (draft: AppStateRecord) => void) => void;

type ReaderViewportSyncInput = {
  readerRef: RefObject<HTMLDivElement>;
  mode: WorkspaceMode;
  activeDocumentId: string | null;
  activeDocument: DocumentRecord | null;
  activePages: PageRecord[];
  pdfDocument: PdfDocumentProxy | null;
  zoom: number;
  outlineOpen: boolean;
  translationPanelOpen: boolean;
  rightPanelOpen: boolean;
  readerLayout: unknown;
  savedHorizontalScrollLeft: number;
  activeOutlineRows: OutlineRow[];
  patchState: PatchState;
  setPageCursor: Dispatch<SetStateAction<number>>;
  setActiveOutlineId: Dispatch<SetStateAction<string | null>>;
  setPageOutlineAnchors: Dispatch<SetStateAction<Record<number, OutlineAnchor[]>>>;
  setTranslationEligiblePages: Dispatch<SetStateAction<Set<number>>>;
  queueAutoTranslationForPageNumber: (pageNumber: number) => Promise<unknown>;
};

export function useReaderViewportSync(input: ReaderViewportSyncInput) {
  const {
    readerRef,
    mode,
    activeDocumentId,
    activeDocument,
    activePages,
    pdfDocument,
    zoom,
    outlineOpen,
    translationPanelOpen,
    rightPanelOpen,
    readerLayout,
    savedHorizontalScrollLeft,
    activeOutlineRows,
    patchState,
    setPageCursor,
    setActiveOutlineId,
    setPageOutlineAnchors,
    setTranslationEligiblePages,
    queueAutoTranslationForPageNumber,
  } = input;

  const scrollSaveTimerRef = useRef<number | null>(null);
  const readerScrollSyncFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const element = readerRef.current;
    if (!element || mode !== "reader" || !activeDocumentId || !pdfDocument) {
      return;
    }
    let frame = window.requestAnimationFrame(() => {
      element.scrollLeft = Math.min(savedHorizontalScrollLeft, Math.max(0, element.scrollWidth - element.clientWidth));
      frame = window.requestAnimationFrame(() => {
        element.scrollLeft = Math.min(savedHorizontalScrollLeft, Math.max(0, element.scrollWidth - element.clientWidth));
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeDocumentId,
    pdfDocument,
    zoom,
    mode,
    outlineOpen,
    translationPanelOpen,
    rightPanelOpen,
    readerLayout,
    savedHorizontalScrollLeft,
    readerRef,
  ]);

  useEffect(
    () => () => {
      if (scrollSaveTimerRef.current !== null) {
        window.clearTimeout(scrollSaveTimerRef.current);
      }
      if (readerScrollSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(readerScrollSyncFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const element = readerRef.current;
    if (!element || mode !== "reader") {
      return;
    }
    scheduleReaderCursorSync(element);
  }, [mode, activeDocumentId, activeOutlineRows, zoom]);

  function scheduleHorizontalScrollSave(scrollLeft: number) {
    if (!activeDocumentId) {
      return;
    }
    const next = Math.max(0, Math.round(scrollLeft));
    if (Math.abs(next - savedHorizontalScrollLeft) < 2) {
      return;
    }
    if (scrollSaveTimerRef.current !== null) {
      window.clearTimeout(scrollSaveTimerRef.current);
    }
    const documentId = activeDocumentId;
    scrollSaveTimerRef.current = window.setTimeout(() => {
      scrollSaveTimerRef.current = null;
      const key = documentHorizontalScrollSettingKey(documentId);
      patchState((draft) => {
        draft.settings[key] = String(next);
      });
      void setSetting(key, String(next));
    }, 180);
  }

  function rememberOutlineAnchors(pageNumber: number, anchors: OutlineAnchor[]) {
    setPageOutlineAnchors((current) => {
      const next = anchors
        .slice()
        .sort((a, b) => a.top - b.top)
        .map((anchor) => ({ ...anchor, page: pageNumber }));
      const previous = current[pageNumber] ?? [];
      const previousKey = previous.map((anchor) => `${anchor.id}:${Math.round(anchor.top)}:${anchor.title}`).join("|");
      const nextKey = next.map((anchor) => `${anchor.id}:${Math.round(anchor.top)}:${anchor.title}`).join("|");
      if (previousKey === nextKey) {
        return current;
      }
      return { ...current, [pageNumber]: next };
    });
  }

  function scrollReaderToElement(element: HTMLElement, behavior: ScrollBehavior = "smooth") {
    const container = readerRef.current;
    if (!container) {
      element.scrollIntoView({ behavior, block: "start" });
      return;
    }
    const containerBox = container.getBoundingClientRect();
    const targetBox = element.getBoundingClientRect();
    const top = container.scrollTop + (targetBox.top - containerBox.top) - 18;
    container.scrollTo({ top: Math.max(0, top), behavior });
  }

  function goToPage(page: number) {
    const maxPage = pdfDocument?.numPages ?? activeDocument?.pageCount ?? (activePages.length || 1);
    const next = clampNumber(page, 1, Math.max(1, maxPage));
    setPageCursor(next);
    setActiveOutlineId(null);
    const target = document.getElementById(`page-${next}`);
    if (target) {
      scrollReaderToElement(target);
    }
  }

  function goToOutlineRow(row: OutlineRow) {
    setPageCursor(row.page);
    setActiveOutlineId(row.id);
    const anchorId = row.anchorId ? outlineAnchorDomId(row.anchorId) : "";
    const target = anchorId ? document.getElementById(anchorId) : document.getElementById(`page-${row.page}`);
    if (target) {
      scrollReaderToElement(target);
    }
  }

  function allowTranslationForPage(page: number, options: { queue?: boolean } = {}) {
    if (!Number.isFinite(page) || page < 1) {
      return;
    }
    const maxPage = Math.max(1, pdfDocument?.numPages ?? activeDocument?.pageCount ?? activePages.length ?? 1);
    const nextPage = clampNumber(Math.floor(page), 1, maxPage);
    setTranslationEligiblePages((current) => {
      if (current.has(nextPage)) {
        return current;
      }
      const next = new Set(current);
      next.add(nextPage);
      return next;
    });
    if (options.queue) {
      void queueAutoTranslationForPageNumber(nextPage);
    }
  }

  function syncReaderCursorFromScroll(element: HTMLElement) {
    const pageShells = Array.from(element.querySelectorAll<HTMLElement>(".pdf-page-shell"));
    if (pageShells.length === 0) {
      return;
    }
    const markerTop = element.scrollTop + 72;
    const containerBox = element.getBoundingClientRect();
    let nextPage = Number(pageShells[0].dataset.page ?? 1) || 1;
    for (const shell of pageShells) {
      const page = Number(shell.dataset.page ?? 0);
      if (page > 0 && shell.offsetTop <= markerTop) {
        nextPage = page;
      } else {
        break;
      }
    }
    setPageCursor((current) => (current === nextPage ? current : nextPage));
    const currentShell = pageShells.find((shell) => Number(shell.dataset.page ?? 0) === nextPage);
    if (currentShell) {
      const visibleBottom = element.scrollTop + element.clientHeight;
      const progress = (visibleBottom - currentShell.offsetTop) / Math.max(1, currentShell.offsetHeight);
      if (progress >= nextPageTranslationReadProgress) {
        allowTranslationForPage(nextPage + 1, { queue: true });
      }
    }
    const anchors = Array.from(element.querySelectorAll<HTMLElement>("[data-outline-anchor-id]"));
    let nextOutlineId: string | null = null;
    for (const anchor of anchors) {
      const anchorTop = element.scrollTop + (anchor.getBoundingClientRect().top - containerBox.top);
      if (anchorTop <= markerTop + 8) {
        nextOutlineId = anchor.dataset.outlineAnchorId ?? nextOutlineId;
      } else {
        break;
      }
    }
    if (!nextOutlineId) {
      nextOutlineId = activeOutlineRows.find((row) => row.page === nextPage)?.id ?? activeOutlineRows[0]?.id ?? null;
    }
    setActiveOutlineId((current) => (current === nextOutlineId ? current : nextOutlineId));
  }

  function scheduleReaderCursorSync(element: HTMLElement) {
    if (readerScrollSyncFrameRef.current !== null) {
      window.cancelAnimationFrame(readerScrollSyncFrameRef.current);
    }
    readerScrollSyncFrameRef.current = window.requestAnimationFrame(() => {
      readerScrollSyncFrameRef.current = null;
      syncReaderCursorFromScroll(element);
    });
  }

  function restoreReaderBookmark(bookmark: ReaderBookmark) {
    setPageCursor(bookmark.page);
    setActiveOutlineId(null);
    const scrollToBookmark = () => {
      const element = readerRef.current;
      if (!element) {
        return;
      }
      const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
      const maxLeft = Math.max(0, element.scrollWidth - element.clientWidth);
      const targetTop = Number.isFinite(bookmark.scrollTop)
        ? bookmark.scrollTop
        : bookmark.scrollRatio * maxTop;
      element.scrollTo({
        top: clampNumber(targetTop, 0, maxTop),
        left: clampNumber(bookmark.scrollLeft, 0, maxLeft),
        behavior: "auto",
      });
      scheduleReaderCursorSync(element);
    };
    window.requestAnimationFrame(() => {
      scrollToBookmark();
      window.requestAnimationFrame(scrollToBookmark);
      window.setTimeout(scrollToBookmark, 140);
    });
  }

  return {
    scheduleHorizontalScrollSave,
    rememberOutlineAnchors,
    goToPage,
    goToOutlineRow,
    restoreReaderBookmark,
    scheduleReaderCursorSync,
  };
}
