import { useEffect, useRef } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { outlineAnchorDomId, type OutlineAnchor, type OutlineRow } from "../lib/outlines";
import {
  clampNumber,
  documentHorizontalScrollSettingKey,
  documentLastReaderViewportSettingKey,
  nextPageTranslationReadProgress,
  type ReaderBookmark,
} from "../lib/readerSettings";
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
  lastReaderViewport: ReaderBookmark | null;
  activeOutlineRows: OutlineRow[];
  patchState: PatchState;
  commitZoom: (zoom: number) => void;
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
    lastReaderViewport,
    activeOutlineRows,
    patchState,
    commitZoom,
    setPageCursor,
    setActiveOutlineId,
    setPageOutlineAnchors,
    setTranslationEligiblePages,
    queueAutoTranslationForPageNumber,
  } = input;

  const scrollSaveTimerRef = useRef<number | null>(null);
  const lastViewportSaveTimerRef = useRef<number | null>(null);
  const pendingLastViewportRef = useRef<ReaderBookmark | null>(null);
  const savedLastViewportRef = useRef<ReaderBookmark | null>(lastReaderViewport);
  const restoredLastViewportDocumentRef = useRef<string | null>(null);
  const lastViewportSavePausedUntilRef = useRef(0);
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

  useEffect(() => {
    savedLastViewportRef.current = lastReaderViewport;
  }, [lastReaderViewport]);

  useEffect(() => {
    restoredLastViewportDocumentRef.current = null;
  }, [activeDocumentId, pdfDocument]);

  useEffect(() => {
    if (mode !== "reader") {
      restoredLastViewportDocumentRef.current = null;
    }
  }, [mode]);

  useEffect(() => {
    const documentId = activeDocumentId;
    return () => {
      if (documentId) {
        flushLastReaderViewportSave();
      }
    };
  }, [activeDocumentId, mode, pdfDocument]);

  useEffect(() => {
    if (mode !== "reader" || !activeDocumentId || !pdfDocument) {
      return;
    }
    const flush = () => flushLastReaderViewportSave();
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [activeDocumentId, mode, pdfDocument]);

  useEffect(() => {
    if (!activeDocumentId || !pdfDocument || mode !== "reader" || !lastReaderViewport) {
      return;
    }
    if (restoredLastViewportDocumentRef.current === activeDocumentId) {
      return;
    }
    const maxPage = Math.max(1, pdfDocument.numPages ?? activeDocument?.pageCount ?? activePages.length ?? 1);
    const bookmark = {
      ...lastReaderViewport,
      page: Math.round(clampNumber(lastReaderViewport.page, 1, maxPage)),
    };
    lastViewportSavePausedUntilRef.current = performance.now() + 1200;
    if (Math.abs(zoom - bookmark.zoom) >= 0.001) {
      commitZoom(bookmark.zoom);
      return;
    }
    restoredLastViewportDocumentRef.current = activeDocumentId;
    restoreReaderBookmark(bookmark);
  }, [activeDocumentId, activeDocument?.pageCount, activePages.length, commitZoom, lastReaderViewport, mode, pdfDocument, zoom]);

  useEffect(
    () => () => {
      if (scrollSaveTimerRef.current !== null) {
        window.clearTimeout(scrollSaveTimerRef.current);
      }
      if (lastViewportSaveTimerRef.current !== null) {
        window.clearTimeout(lastViewportSaveTimerRef.current);
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

  function viewportMatches(left: ReaderBookmark | null, right: ReaderBookmark | null) {
    if (!left || !right) {
      return false;
    }
    return (
      left.documentId === right.documentId &&
      left.page === right.page &&
      Math.abs(left.zoom - right.zoom) < 0.001 &&
      Math.abs(left.scrollTop - right.scrollTop) < 2 &&
      Math.abs(left.scrollLeft - right.scrollLeft) < 2 &&
      Math.abs(left.scrollRatio - right.scrollRatio) < 0.002
    );
  }

  function pageAtReaderMarker(element: HTMLElement) {
    return visibleReaderPage(element)?.page ?? null;
  }

  function readerFocusMarkerTop(element: HTMLElement) {
    const fallback = element.clientHeight * 0.42;
    const offset = element.clientHeight >= 240 ? clampNumber(element.clientHeight * 0.38, 96, element.clientHeight - 96) : fallback;
    return element.scrollTop + offset;
  }

  function visibleReaderPage(element: HTMLElement) {
    const pageShells = Array.from(element.querySelectorAll<HTMLElement>(".pdf-page-shell"));
    if (pageShells.length === 0) {
      return null;
    }
    const viewportTop = element.scrollTop;
    const viewportBottom = element.scrollTop + element.clientHeight;
    const focusTop = readerFocusMarkerTop(element);
    let best:
      | {
          page: number;
          shell: HTMLElement;
          visibleHeight: number;
          focusDistance: number;
        }
      | null = null;
    for (const shell of pageShells) {
      const page = Number(shell.dataset.page ?? 0);
      if (page <= 0) {
        continue;
      }
      const top = shell.offsetTop;
      const bottom = top + shell.offsetHeight;
      const visibleHeight = Math.max(0, Math.min(bottom, viewportBottom) - Math.max(top, viewportTop));
      if (visibleHeight <= 0) {
        continue;
      }
      const focusDistance = focusTop < top ? top - focusTop : focusTop > bottom ? focusTop - bottom : 0;
      if (
        !best ||
        visibleHeight > best.visibleHeight + 8 ||
        (Math.abs(visibleHeight - best.visibleHeight) <= 8 && focusDistance < best.focusDistance)
      ) {
        best = { page, shell, visibleHeight, focusDistance };
      }
    }
    if (best) {
      return best;
    }
    const markerTop = readerFocusMarkerTop(element);
    let fallback = Number(pageShells[0].dataset.page ?? 1) || 1;
    let fallbackShell = pageShells[0];
    for (const shell of pageShells) {
      const page = Number(shell.dataset.page ?? 0);
      if (page > 0 && shell.offsetTop <= markerTop) {
        fallback = page;
        fallbackShell = shell;
      } else {
        break;
      }
    }
    return { page: fallback, shell: fallbackShell, visibleHeight: 0, focusDistance: 0 };
  }

  function captureLastReaderViewport(element: HTMLElement): ReaderBookmark | null {
    if (!activeDocumentId || mode !== "reader" || !pdfDocument) {
      return null;
    }
    const page = pageAtReaderMarker(element);
    if (!page) {
      return null;
    }
    const maxPage = Math.max(1, pdfDocument.numPages ?? activeDocument?.pageCount ?? activePages.length ?? 1);
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    return {
      id: "reader-last-viewport",
      documentId: activeDocumentId,
      page: Math.round(clampNumber(page, 1, maxPage)),
      zoom,
      scrollTop: Math.max(0, Math.round(element.scrollTop)),
      scrollLeft: Math.max(0, Math.round(element.scrollLeft)),
      scrollRatio: maxTop > 0 ? clampNumber(element.scrollTop / maxTop, 0, 1) : 0,
      createdAt: new Date().toISOString(),
    };
  }

  function persistLastReaderViewport(viewport: ReaderBookmark) {
    if (viewportMatches(viewport, savedLastViewportRef.current)) {
      return;
    }
    const key = documentLastReaderViewportSettingKey(viewport.documentId);
    const value = JSON.stringify(viewport);
    savedLastViewportRef.current = viewport;
    patchState((draft) => {
      draft.settings[key] = value;
    });
    void setSetting(key, value);
  }

  function flushLastReaderViewportSave() {
    if (lastViewportSaveTimerRef.current !== null) {
      window.clearTimeout(lastViewportSaveTimerRef.current);
      lastViewportSaveTimerRef.current = null;
    }
    const pending = pendingLastViewportRef.current;
    pendingLastViewportRef.current = null;
    if (pending) {
      persistLastReaderViewport(pending);
    }
  }

  function scheduleLastReaderViewportSave(element: HTMLElement) {
    if (performance.now() < lastViewportSavePausedUntilRef.current) {
      return;
    }
    const viewport = captureLastReaderViewport(element);
    if (!viewport || viewportMatches(viewport, savedLastViewportRef.current) || viewportMatches(viewport, pendingLastViewportRef.current)) {
      return;
    }
    pendingLastViewportRef.current = viewport;
    if (lastViewportSaveTimerRef.current !== null) {
      window.clearTimeout(lastViewportSaveTimerRef.current);
    }
    lastViewportSaveTimerRef.current = window.setTimeout(() => {
      lastViewportSaveTimerRef.current = null;
      const pending = pendingLastViewportRef.current;
      pendingLastViewportRef.current = null;
      if (pending) {
        persistLastReaderViewport(pending);
      }
    }, 320);
  }

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
    const containerBox = element.getBoundingClientRect();
    const currentPageCandidate = visibleReaderPage(element);
    const markerTop = currentPageCandidate
      ? Math.max(readerFocusMarkerTop(element), currentPageCandidate.shell.offsetTop + 8)
      : readerFocusMarkerTop(element);
    const nextPage = (currentPageCandidate?.page ?? Number(pageShells[0].dataset.page ?? 1)) || 1;
    setPageCursor((current) => (current === nextPage ? current : nextPage));
    const currentShell = currentPageCandidate?.shell ?? pageShells.find((shell) => Number(shell.dataset.page ?? 0) === nextPage);
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
    scheduleLastReaderViewportSave(element);
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
