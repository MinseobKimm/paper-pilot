import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { AiResultRecord, AiTaskType, AnnotationRecord, AppStateRecord, DocumentRecord, PageRecord } from "../types";
import { makeId, nowIso } from "../lib/ids";
import { canvasToCompressedImageDataUrl, cleanSelection, compactUiText } from "../lib/fileActions";
import { createAutoHighlights, highlightColors } from "../lib/highlights";
import { selectionFromTextLayer, type DocumentTextLayoutMode, type SelectionToolbar, type TextSelectionGesture } from "../lib/pdfText";
import { explanationColor, explanationTag } from "../lib/annotationHelpers";
import { upsertAnnotation, upsertComment } from "../lib/tauri";
import type { UiLanguage, UiStrings } from "../lib/uiStrings";

type PatchState = (mutator: (draft: AppStateRecord) => void) => void;

type QueueTask = (
  taskType: AiTaskType,
  payload: Record<string, unknown>,
  options?: { silent?: boolean; keepPanel?: boolean },
) => Promise<AiResultRecord | null>;

type ReaderSelectionInput = {
  activeDocument: DocumentRecord | null;
  activePages: PageRecord[];
  activeDocumentTextLayoutMode: DocumentTextLayoutMode | "";
  ui: UiStrings;
  uiLanguage: UiLanguage;
  patchState: PatchState;
  showToast: (message: string, kind?: "info" | "error") => void;
  queueTask: QueueTask;
  copyText: (text: string, label: string) => Promise<void>;
};

export type ReaderMarkupTool =
  | { kind: "none" }
  | { kind: "highlight"; color: string }
  | { kind: "erase" };

export function useReaderSelection(input: ReaderSelectionInput) {
  const {
    activeDocument,
    activePages,
    activeDocumentTextLayoutMode,
    ui,
    uiLanguage,
    patchState,
    showToast,
    queueTask,
    copyText,
  } = input;
  const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbar | null>(null);
  const [textSelectionPreview, setTextSelectionPreview] = useState<{ page: number; rects: AnnotationRecord['rects'] } | null>(null);
  const [markupTool, setMarkupTool] = useState<ReaderMarkupTool>({ kind: "none" });
  const [regionMode, setRegionMode] = useState(false);
  const [regionDrag, setRegionDrag] = useState<{
    page: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const textSelectionGestureRef = useRef<TextSelectionGesture | null>(null);
  function handleReaderMouseUp(event?: ReactMouseEvent) {
    const selection = window.getSelection();
    const activeGesture = textSelectionGestureRef.current
      ? {
          ...textSelectionGestureRef.current,
          endX: event?.clientX ?? textSelectionGestureRef.current.endX,
          endY: event?.clientY ?? textSelectionGestureRef.current.endY,
        }
      : undefined;
    textSelectionGestureRef.current = null;
    setTextSelectionPreview(null);
    const nativeText = selection ? cleanSelection(selection.toString()) : "";
    const hasNativeSelection = Boolean(selection && selection.rangeCount > 0 && nativeText.length >= 2);
    const hasDraggedText =
      Boolean(activeGesture) &&
      Math.hypot((activeGesture?.endX ?? 0) - (activeGesture?.startX ?? 0), (activeGesture?.endY ?? 0) - (activeGesture?.startY ?? 0)) >= 5;
    if (!hasNativeSelection && !hasDraggedText) {
      setSelectionToolbar(null);
      selection?.removeAllRanges();
      return;
    }
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    const container = range
      ? range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement
      : null;
    let page = activeGesture?.pageElement ?? container?.closest<HTMLElement>(".pdf-page-shell") ?? null;
    const rangeRects = range ? Array.from(range.getClientRects()).filter((rect) => rect.width > 1 && rect.height > 1) : [];
    if (!page && rangeRects.length > 0) {
      for (const rect of rangeRects) {
        const hit = document
          .elementFromPoint(rect.left + Math.min(4, rect.width / 2), rect.top + Math.min(4, rect.height / 2))
          ?.closest<HTMLElement>(".pdf-page-shell");
        if (hit) {
          page = hit;
          break;
        }
      }
    }
    if (!page) {
      setSelectionToolbar(null);
      selection?.removeAllRanges();
      return;
    }
    const gesture = activeGesture && activeGesture.pageElement === page ? activeGesture : undefined;
    const pageBounds = page.getBoundingClientRect();
    const textLayerSelection = selectionFromTextLayer(page, selection, rangeRects, gesture, activeDocumentTextLayoutMode || "auto");
    const fallbackRects = rangeRects
      .filter((rect) => rect.right >= pageBounds.left && rect.left <= pageBounds.right && rect.bottom >= pageBounds.top && rect.top <= pageBounds.bottom)
      .map((rect) => ({
        x: Math.max(0, Math.round((Math.max(rect.left, pageBounds.left) - pageBounds.left) * 10) / 10),
        y: Math.max(0, Math.round((Math.max(rect.top, pageBounds.top) - pageBounds.top) * 10) / 10),
        width: Math.max(1, Math.round((Math.min(rect.right, pageBounds.right) - Math.max(rect.left, pageBounds.left)) * 10) / 10),
        height: Math.max(1, Math.round((Math.min(rect.bottom, pageBounds.bottom) - Math.max(rect.top, pageBounds.top)) * 10) / 10),
        basisWidth: Math.round(pageBounds.width * 10) / 10,
        basisHeight: Math.round(pageBounds.height * 10) / 10,
      }))
      .filter((rect) => rect.width > 2 && rect.height > 2);
    const rect = range?.getBoundingClientRect();
    const toolbar =
      textLayerSelection ??
      (rect && nativeText.length >= 2
        ? ({
            text: nativeText,
            page: Number(page.dataset.page ?? "1"),
            x: rect.left + rect.width / 2,
            y: Math.max(72, rect.top - 46),
            rects: fallbackRects,
          } satisfies SelectionToolbar)
        : null);
    if (!toolbar || cleanSelection(toolbar.text).length < 2 || toolbar.rects.length === 0) {
      setSelectionToolbar(null);
      selection?.removeAllRanges();
      return;
    }
    if (markupTool.kind === "erase") {
      setSelectionToolbar(null);
      selection?.removeAllRanges();
      return;
    }
    if (markupTool.kind === "highlight") {
      setSelectionToolbar(null);
      selection?.removeAllRanges();
      setTextSelectionPreview(null);
      void createManualHighlightFromToolbar(toolbar, markupTool.color);
      return;
    }
    setSelectionToolbar(toolbar);
    setTextSelectionPreview({ page: toolbar.page, rects: toolbar.rects });
    selection?.removeAllRanges();
  }

  function getCanvasPoint(event: ReactMouseEvent) {
    const target = event.target as Element;
    const shell = target.closest<HTMLElement>(".pdf-page-shell");
    const canvas = shell?.querySelector("canvas");
    if (!shell || !canvas) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    return { shell, canvas, rect, x, y, page: Number(shell.dataset.page ?? "1") };
  }

  function handleRegionMouseDown(event: ReactMouseEvent) {
    if (!regionMode) {
      if (event.button === 0) {
        const textTarget = (event.target as Element | null)?.closest<HTMLElement>(".text-layer [data-text]");
        const textLayer = (event.target as Element | null)?.closest<HTMLElement>(".text-layer");
        const page = (textTarget ?? textLayer)?.closest<HTMLElement>(".pdf-page-shell");
        if (page) {
          event.preventDefault();
          setSelectionToolbar(null);
          textSelectionGestureRef.current = {
            page: Number(page.dataset.page ?? "1"),
            pageElement: page,
            startX: event.clientX,
            startY: event.clientY,
            endX: event.clientX,
            endY: event.clientY,
          };
          setTextSelectionPreview(null);
        } else {
          textSelectionGestureRef.current = null;
          setTextSelectionPreview(null);
        }
      }
      return;
    }
    textSelectionGestureRef.current = null;
    setTextSelectionPreview(null);
    const point = getCanvasPoint(event);
    if (!point) {
      return;
    }
    event.preventDefault();
    setRegionDrag({
      page: point.page,
      startX: point.x,
      startY: point.y,
      x: point.x,
      y: point.y,
      width: 0,
      height: 0,
    });
  }

  function handleRegionMouseMove(event: ReactMouseEvent) {
    if (!regionMode) {
      const gesture = textSelectionGestureRef.current;
      if (!gesture) {
        return;
      }
      const nextGesture = {
        ...gesture,
        endX: event.clientX,
        endY: event.clientY,
      };
      textSelectionGestureRef.current = nextGesture;
      const toolbar = selectionFromTextLayer(nextGesture.pageElement, null, [], nextGesture, activeDocumentTextLayoutMode || "auto");
      if (!toolbar || toolbar.rects.length === 0) {
        setTextSelectionPreview(null);
        return;
      }
      event.preventDefault();
      setTextSelectionPreview({ page: toolbar.page, rects: toolbar.rects });
      return;
    }
    if (!regionDrag) {
      return;
    }
    const point = getCanvasPoint(event);
    if (!point || point.page !== regionDrag.page) {
      return;
    }
    event.preventDefault();
    const x = Math.min(point.x, regionDrag.startX);
    const y = Math.min(point.y, regionDrag.startY);
    setRegionDrag({
      ...regionDrag,
      x,
      y,
      width: Math.abs(point.x - regionDrag.startX),
      height: Math.abs(point.y - regionDrag.startY),
    });
  }

  async function finishRegionExplain(event: ReactMouseEvent) {
    if (!regionMode) {
      handleReaderMouseUp(event);
      return;
    }
    const point = getCanvasPoint(event);
    const drag = regionDrag;
    setRegionMode(false);
    setRegionDrag(null);
    if (!point || !drag || drag.width < 8 || drag.height < 8) {
      showToast(ui.regionSelectionCancelled);
      return;
    }
    event.preventDefault();
    const scaleX = point.canvas.width / point.rect.width;
    const scaleY = point.canvas.height / point.rect.height;
    const crop = document.createElement("canvas");
    crop.width = Math.max(1, Math.round(drag.width * scaleX));
    crop.height = Math.max(1, Math.round(drag.height * scaleY));
    const context = crop.getContext("2d");
    if (!context) {
      return;
    }
    context.drawImage(
      point.canvas,
      Math.round(drag.x * scaleX),
      Math.round(drag.y * scaleY),
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height,
    );
    const regionPage = activePages.find((page) => page.pageNumber === drag.page);
    const regionPageText = regionPage ? compactUiText(regionPage.text, 3200) : "";
    const queued = await queueTask("explainRegionImage", {
      page: drag.page,
      region: {
        x: Math.round(drag.x),
        y: Math.round(drag.y),
        width: Math.round(drag.width),
        height: Math.round(drag.height),
      },
      imageDataUrl: canvasToCompressedImageDataUrl(crop),
      text: regionPageText ? `Image region page ${drag.page} context:\n${regionPageText}` : "",
      pages: regionPage
        ? [
            {
              ...regionPage,
              text: regionPageText,
              outlineLabel: compactUiText(regionPage.outlineLabel, 160),
            },
          ]
        : [],
    });
    if (queued && activeDocument) {
      const annotation: AnnotationRecord = {
        id: makeId("explain"),
        documentId: activeDocument.id,
        page: drag.page,
        kind: "manual",
        color: explanationColor,
        text: "Image region explanation",
        rangeHint: `Image region ${Math.round(drag.x)},${Math.round(drag.y)},${Math.round(drag.width)},${Math.round(drag.height)}`,
        rects: [
          {
            x: Math.round(drag.x * 10) / 10,
            y: Math.round(drag.y * 10) / 10,
            width: Math.round(drag.width * 10) / 10,
            height: Math.round(drag.height * 10) / 10,
            basisWidth: Math.round(point.rect.width * 10) / 10,
            basisHeight: Math.round(point.rect.height * 10) / 10,
          },
        ],
        comment: `ai:${queued.id}`,
        tag: explanationTag,
        createdAt: nowIso(),
      };
      const saved = await upsertAnnotation(annotation);
      patchState((draft) => {
        draft.annotations = [saved, ...draft.annotations.filter((item) => item.id !== saved.id)];
      });
      showToast(ui.imageExplanationButtonSaved);
    }
  }

  async function createManualHighlightFromToolbar(toolbar: SelectionToolbar, color: string, comment = "") {
    if (!activeDocument) {
      return;
    }
    const annotation: AnnotationRecord = {
      id: makeId("ann"),
      documentId: activeDocument.id,
      page: toolbar.page,
      kind: "manual",
      color,
      text: toolbar.text,
      rangeHint: toolbar.text.slice(0, 160),
      rects: toolbar.rects,
      comment,
      tag: "Manual",
      createdAt: nowIso(),
    };
    const saved = await upsertAnnotation(annotation);
    if (comment.trim()) {
      const savedComment = await upsertComment({
        id: makeId("comment"),
        annotationId: saved.id,
        documentId: saved.documentId,
        page: saved.page,
        text: comment,
        createdAt: nowIso(),
      });
      patchState((draft) => {
        draft.comments = [savedComment, ...draft.comments.filter((item) => item.id !== savedComment.id)];
      });
    }
    patchState((draft) => {
      draft.annotations = [saved, ...draft.annotations.filter((item) => item.id !== saved.id)];
    });
    setSelectionToolbar(null);
    setTextSelectionPreview(null);
  }

  async function createManualHighlight(color: string, comment = "") {
    if (!selectionToolbar) {
      return;
    }
    await createManualHighlightFromToolbar(selectionToolbar, color, comment);
  }

  async function addCommentFromSelection() {
    const comment = window.prompt(ui.commentPrompt);
    if (comment !== null) {
      await createManualHighlight("#f6c85f", comment);
    }
  }

  async function explainSelection() {
    if (!activeDocument || !selectionToolbar) {
      return;
    }
    const toolbar = selectionToolbar;
    const queued = await queueTask("explainText", { text: toolbar.text, page: toolbar.page });
    if (!queued) {
      return;
    }
    const annotation: AnnotationRecord = {
      id: makeId("explain"),
      documentId: activeDocument.id,
      page: toolbar.page,
      kind: "manual",
      color: explanationColor,
      text: toolbar.text,
      rangeHint: toolbar.text.slice(0, 160),
      rects: toolbar.rects,
      comment: `ai:${queued.id}`,
      tag: explanationTag,
      createdAt: nowIso(),
    };
    const saved = await upsertAnnotation(annotation);
    patchState((draft) => {
      draft.annotations = [saved, ...draft.annotations.filter((item) => item.id !== saved.id)];
    });
    setSelectionToolbar(null);
    setTextSelectionPreview(null);
    showToast(ui.explanationButtonSaved);
  }

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && selectionToolbar) {
        event.preventDefault();
        void copyText(selectionToolbar.text, ui.copy);
        return;
      }
      const color = highlightColors.find((item) => item.key === event.key);
      if (selectionToolbar && color) {
        event.preventDefault();
        void createManualHighlight(color.value);
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  });

  return {
    selectionToolbar,
    setSelectionToolbar,
    textSelectionPreview,
    setTextSelectionPreview,
    markupTool,
    setMarkupTool,
    regionMode,
    setRegionMode,
    regionDrag,
    handleReaderMouseUp,
    handleRegionMouseDown,
    handleRegionMouseMove,
    finishRegionExplain,
    createManualHighlight,
    addCommentFromSelection,
    explainSelection,
  };
}
