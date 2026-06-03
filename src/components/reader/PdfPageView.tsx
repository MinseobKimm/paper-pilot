import { useEffect, useRef, useState } from "react";
import { Sparkles, X } from "../icons";
import type { AnnotationRecord, HighlightRect, PageRecord } from "../../types";
import type { PdfDocumentProxy } from "../../lib/pdfDocument";
import { defaultReaderZoom } from "../../lib/readerSettings";
import {
  dehyphenateLineBreaks,
  inferPageTextLayoutFromPdfItems,
  textBoxesFromPdfItems,
  type DocumentTextLayoutMode,
  type PageTextLayoutInference,
  type TextLayerBox,
} from "../../lib/pdfText";
import { detectedOutlineAnchorsForPage, outlineAnchorDomId, type OutlineAnchor } from "../../lib/outlines";
import { sentenceBounds, type SentenceUnit } from "../../lib/translations";
import { referencePreviewTargetsForPage, type PdfLinkPreviewTarget } from "../../lib/linkPreviews";
import { isExplanationAnnotation } from "../../lib/annotationHelpers";
import { normalizeForMatch } from "../../lib/textUtils";
import { annotateHyphenatedTextSpans, clickedWordFromTextSpan, type WordPopup } from "../../lib/wordMeanings";
import { useUiStrings } from "../../lib/uiStrings";
type PdfPageViewProps = {
  pdf: PdfDocumentProxy;
  documentId: string;
  pageNumber: number;
  zoom: number;
  searchTerm: string;
  referencePages: PageRecord[];
  annotations: AnnotationRecord[];
  hoverSource: string | null;
  sentenceUnits: SentenceUnit[];
  selectedSentenceIds: string[];
  highlightEraseActive: boolean;
  selectionPreviewRects: HighlightRect[];
  textLayoutMode: DocumentTextLayoutMode | "";
  onTextLayoutReady: (pageNumber: number, inference: PageTextLayoutInference) => void;
  onWordSelect: (popup: WordPopup) => void;
  regionDrag: {
    page: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  onTextReady: (page: PageRecord) => void;
  onOutlineReady: (pageNumber: number, anchors: OutlineAnchor[]) => void;
  onImageReady: (pageNumber: number, image: string) => void;
  captureImage: boolean;
  onOpenExplanation: (annotation: AnnotationRecord) => void;
  onDeleteAnnotation: (id: string) => void;
  onPreviewLink: (target: PdfLinkPreviewTarget) => void;
};

export function PdfPageView(props: PdfPageViewProps) {
  const ui = useUiStrings();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const wordClickStartRef = useRef<{ x: number; y: number } | null>(null);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [derivedRects, setDerivedRects] = useState<Record<string, HighlightRect[]>>({});
  const [linkTargets, setLinkTargets] = useState<PdfLinkPreviewTarget[]>([]);
  const [referenceTargets, setReferenceTargets] = useState<PdfLinkPreviewTarget[]>([]);
  const [textLayerMetrics, setTextLayerMetrics] = useState<{ text: string; boxes: TextLayerBox[] }>({ text: "", boxes: [] });
  const [outlineAnchors, setOutlineAnchors] = useState<OutlineAnchor[]>([]);
  const regionBox = props.regionDrag?.page === props.pageNumber ? props.regionDrag : null;
  const sentenceKey = props.sentenceUnits.map((unit) => `${unit.id}:${unit.source}`).join("|");
  const selectedSentenceKey = props.selectedSentenceIds.join("|");
  const annotationRenderKey = props.annotations
    .map((annotation) => `${annotation.id}:${annotation.text}:${annotation.rangeHint}:${annotation.rects.length}`)
    .join("|");
  const scaledRect = (rect: HighlightRect) => {
    const fallbackBasisWidth = pageSize.width && props.zoom ? (pageSize.width / props.zoom) * defaultReaderZoom : 0;
    const fallbackBasisHeight = pageSize.height && props.zoom ? (pageSize.height / props.zoom) * defaultReaderZoom : 0;
    const basisWidth = rect.basisWidth ?? fallbackBasisWidth;
    const basisHeight = rect.basisHeight ?? fallbackBasisHeight;
    const scaleX = basisWidth && pageSize.width ? pageSize.width / basisWidth : 1;
    const scaleY = basisHeight && pageSize.height ? pageSize.height / basisHeight : 1;
    return {
      left: rect.x * scaleX,
      top: rect.y * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
    };
  };

  useEffect(() => {
    const layer = textLayerRef.current;
    const shell = layer?.closest<HTMLElement>(".pdf-page-shell");
    if (!layer || !shell || !pageSize.width || !pageSize.height) {
      setDerivedRects({});
      return;
    }
    const shellBox = shell.getBoundingClientRect();
    const spans = Array.from(layer.querySelectorAll<HTMLElement>("[data-text]"));
    const next: Record<string, HighlightRect[]> = {};
    for (const annotation of props.annotations) {
      if (annotation.rects.length > 0) {
        continue;
      }
      const target = normalizeForMatch(annotation.text || annotation.rangeHint);
      if (target.length < 4) {
        continue;
      }
      const rects = spans
        .filter((span) => {
          const raw = normalizeForMatch(span.dataset.text || "");
          return raw.length >= 4 && (target.includes(raw) || raw.includes(target));
        })
        .map((span) => {
          const box = span.getBoundingClientRect();
          return {
            x: Math.max(0, box.left - shellBox.left),
            y: Math.max(0, box.top - shellBox.top),
            width: box.width,
            height: box.height,
            basisWidth: pageSize.width,
            basisHeight: pageSize.height,
          };
        })
        .filter((rect) => rect.width > 2 && rect.height > 2);
      if (rects.length > 0) {
        next[annotation.id] = rects;
      }
    }
    setDerivedRects(next);
  }, [annotationRenderKey, pageSize.width, pageSize.height, sentenceKey]);

  useEffect(() => {
    const nextTargets = referencePreviewTargetsForPage(
      props.pageNumber,
      textLayerMetrics.text,
      textLayerMetrics.boxes,
      props.referencePages,
    );
    setReferenceTargets((current) => {
      const currentKey = current.map((item) => `${item.id}:${item.targetPage}:${Math.round(item.rect.left)}:${Math.round(item.rect.top)}`).join("|");
      const nextKey = nextTargets.map((item) => `${item.id}:${item.targetPage}:${Math.round(item.rect.left)}:${Math.round(item.rect.top)}`).join("|");
      return currentKey === nextKey ? current : nextTargets;
    });
  }, [props.pageNumber, props.referencePages, textLayerMetrics]);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel?: () => void } | null = null;
    async function renderPage() {
      const page = await props.pdf.getPage(props.pageNumber);
      if (cancelled) {
        return;
      }
      const viewport = page.getViewport({ scale: props.zoom });
      const canvas = canvasRef.current;
      const layer = textLayerRef.current;
      if (!canvas || !layer) {
        return;
      }
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setPageSize((current) =>
        current.width === viewport.width && current.height === viewport.height
          ? current
          : { width: viewport.width, height: viewport.height },
      );
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      renderTask = page.render({ canvasContext: context, viewport });
      await renderTask.promise.catch((error: unknown) => {
        if (!cancelled) {
          throw error;
        }
      });
      if (cancelled) {
        return;
      }
      if (props.captureImage) {
        props.onImageReady(props.pageNumber, canvas.toDataURL("image/png"));
      }

      const content = await page.getTextContent();
      const layoutInference = inferPageTextLayoutFromPdfItems(content.items, viewport, props.zoom);
      props.onTextLayoutReady(props.pageNumber, layoutInference);
      const effectiveTextLayoutMode = props.textLayoutMode || layoutInference.mode || "auto";
      const extractedTextLayer = textBoxesFromPdfItems(content.items, viewport, props.zoom, effectiveTextLayoutMode);
      const text =
        dehyphenateLineBreaks(extractedTextLayer.text) ||
        extractedTextLayer.text ||
        content.items.map((item) => item.str ?? "").join(" ").replace(/\s+/g, " ").trim();
      props.onTextReady({
        documentId: props.documentId,
        pageNumber: props.pageNumber,
        text,
        outlineLabel: text.split(/[.!?]\s+/)[0]?.slice(0, 90) || `Page ${props.pageNumber}`,
      });
      setLinkTargets([]);

      layer.innerHTML = "";
      layer.style.width = `${viewport.width}px`;
      layer.style.height = `${viewport.height}px`;
      const bounds = sentenceBounds(text, props.sentenceUnits);
      const selectedIds = new Set(props.selectedSentenceIds);
      let textCursor = 0;
      const textBoxes: TextLayerBox[] = [];
      for (const sourceBox of extractedTextLayer.boxes) {
        const raw = sourceBox.text.trim();
        if (!raw) {
          continue;
        }
        const itemIndex = text.indexOf(raw, textCursor);
        const itemStart = itemIndex >= 0 ? itemIndex : textCursor;
        const itemEnd = itemStart + raw.length;
        textCursor = itemEnd;
        const sentence = bounds.find((bound) => itemStart < bound.end && itemEnd > bound.start);
        const fontHeight = sourceBox.fontSize;
        const span = document.createElement("span");
        span.textContent = `${raw} `;
        span.style.left = `${sourceBox.rect.left}px`;
        span.style.top = `${sourceBox.rect.top}px`;
        span.style.fontSize = `${fontHeight}px`;
        span.style.height = `${sourceBox.rect.height}px`;
        span.style.fontFamily = sourceBox.fontName ? `${sourceBox.fontName}, sans-serif` : "sans-serif";
        span.dataset.text = raw;
        if (sentence) {
          span.dataset.sentenceId = sentence.id;
          span.classList.add("sentence-token");
          if (selectedIds.has(sentence.id)) {
            span.classList.add("sentence-selected");
          }
        }
        const searchHit =
          props.searchTerm.trim().length > 1 && raw.toLowerCase().includes(props.searchTerm.trim().toLowerCase());
        const hoverHit = props.hoverSource && props.hoverSource.toLowerCase().includes(raw.toLowerCase()) && raw.length > 3;
        if (searchHit) {
          span.classList.add("search-hit");
        }
        if (hoverHit) {
          span.classList.add("hover-hit");
        }
        layer.appendChild(span);
        const targetWidth = sourceBox.rect.width;
        const naturalWidth = span.getBoundingClientRect().width;
        if (targetWidth > 0 && naturalWidth > 0) {
          const scaleX = Math.min(3, Math.max(0.2, targetWidth / naturalWidth));
          span.style.transform = `scaleX(${scaleX})`;
        }
        textBoxes.push({
          text: raw,
          start: itemStart,
          end: itemEnd,
          rect: {
            left: sourceBox.rect.left,
            top: sourceBox.rect.top,
            width: targetWidth > 0 ? targetWidth : naturalWidth,
            height: sourceBox.rect.height,
          },
          fontSize: fontHeight,
          fontName: sourceBox.fontName,
        });
      }
      const detectedAnchors = detectedOutlineAnchorsForPage(props.pageNumber, textBoxes, viewport.width, viewport.height);
      annotateHyphenatedTextSpans(layer);
      props.onOutlineReady(props.pageNumber, detectedAnchors);
      setOutlineAnchors(detectedAnchors);
      setTextLayerMetrics({ text, boxes: textBoxes });
    }
    void renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel?.();
    };
  }, [
    props.pdf,
    props.documentId,
    props.pageNumber,
    props.zoom,
    props.textLayoutMode,
    props.searchTerm,
    props.hoverSource,
    sentenceKey,
  ]);

  useEffect(() => {
    const layer = textLayerRef.current;
    if (!layer) {
      return;
    }
    layer.querySelectorAll(".sentence-selected").forEach((node) => {
      node.classList.remove("sentence-selected");
    });
    if (props.selectedSentenceIds.length === 0) {
      return;
    }
    const selectedIds = new Set(props.selectedSentenceIds);
    layer.querySelectorAll<HTMLElement>("[data-sentence-id]").forEach((node) => {
      if (node.dataset.sentenceId && selectedIds.has(node.dataset.sentenceId)) {
        node.classList.add("sentence-selected");
      }
    });
  }, [selectedSentenceKey]);

  const explanationMarkers = props.annotations
    .filter(isExplanationAnnotation)
    .map((annotation) => {
      const rects = annotation.rects.length > 0 ? annotation.rects : derivedRects[annotation.id] ?? [];
      if (rects.length === 0) {
        return null;
      }
      const first = scaledRect(rects[0]);
      return {
        annotation,
        top: Math.max(4, Math.min(pageSize.height - 36, first.top + first.height / 2 - 14)),
        left: Math.max(8, pageSize.width - 82),
      };
    })
    .filter(Boolean) as Array<{ annotation: AnnotationRecord; top: number; left: number }>;
  const previewTargets = [...referenceTargets, ...linkTargets];
  const pageLayoutClass = props.textLayoutMode === "single" ? "layout-single" : props.textLayoutMode === "two-column" ? "layout-two-column" : "layout-auto";

  return (
    <div
      id={`page-${props.pageNumber}`}
      className={`pdf-page-shell ${pageLayoutClass}`}
      data-page={props.pageNumber}
      data-text-layout={props.textLayoutMode || "auto"}
    >
      <div className="page-label">Page {props.pageNumber}</div>
      <canvas ref={canvasRef} />
      <div className={props.highlightEraseActive ? "highlight-layer erase-active" : "highlight-layer"}>
        {props.annotations.flatMap((annotation) => {
          const rects = annotation.rects.length > 0 ? annotation.rects : derivedRects[annotation.id] ?? [];
          return rects.map((rect, index) => {
            const box = scaledRect(rect);
            return (
              <span
                key={`${annotation.id}-${index}`}
                className="highlight-box"
                style={{
                  left: box.left,
                  top: box.top,
                  width: box.width,
                  height: box.height,
                  background: annotation.color,
                }}
                title={annotation.tag || annotation.comment || ui.highlight}
                onMouseDown={(event) => {
                  if (props.highlightEraseActive) {
                    event.stopPropagation();
                  }
                }}
                onMouseUp={(event) => {
                  if (props.highlightEraseActive) {
                    event.stopPropagation();
                  }
                }}
                onClick={(event) => {
                  if (!props.highlightEraseActive) {
                    return;
                  }
                  event.stopPropagation();
                  props.onDeleteAnnotation(annotation.id);
                }}
              />
            );
          });
        })}
        {props.selectionPreviewRects.map((rect, index) => {
          const box = scaledRect(rect);
          return (
            <span
              key={`selection-preview-${index}`}
              className="text-selection-preview-box"
              style={{
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
              }}
            />
          );
        })}
        {regionBox && (
          <span
            className="region-selection-box"
            style={{
              left: regionBox.x,
              top: regionBox.y,
              width: regionBox.width,
              height: regionBox.height,
            }}
          />
        )}
      </div>
      <div className="outline-anchor-layer" aria-hidden="true">
        {outlineAnchors.map((anchor) => (
          <span
            key={anchor.id}
            id={outlineAnchorDomId(anchor.id)}
            className="outline-anchor-marker"
            data-outline-anchor-id={anchor.id}
            style={{ top: anchor.top, left: anchor.left, width: Math.max(8, anchor.width) }}
          />
        ))}
      </div>
      <div className="pdf-link-layer">
        {previewTargets.map((target) => (
          <button
            key={target.id}
            className={[
              "pdf-link-hit",
              target.previewKind === "link" ? "pdf-annotation-hit" : "pdf-reference-hit",
              target.kind === "external" ? "external" : "",
              target.previewKind !== "link" ? target.previewKind : "",
            ]
              .filter(Boolean)
              .join(" ")}
            title={target.kind === "external" ? `${ui.externalLinkPreview}: ${target.url}` : `${target.title} ${ui.preview}`}
            style={{
              left: target.rect.left,
              top: target.rect.top,
              width: target.rect.width,
              height: target.rect.height,
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              props.onPreviewLink(target);
            }}
          >
            <span>{target.previewKind === "link" ? ui.preview : target.title}</span>
          </button>
        ))}
      </div>
      <div className="explanation-anchor-layer">
        {explanationMarkers.map(({ annotation, top, left }) => (
          <span key={annotation.id} className="explanation-anchor" style={{ top, left }}>
            <button title={ui.openSavedExplanation} onClick={() => props.onOpenExplanation(annotation)}>
              <Sparkles size={13} />
            </button>
            <button title={ui.deleteExplanation} onClick={() => props.onDeleteAnnotation(annotation.id)}>
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <div
        ref={textLayerRef}
        className="text-layer"
        onMouseDown={(event) => {
          wordClickStartRef.current = { x: event.clientX, y: event.clientY };
        }}
        onClick={(event) => {
          const clickStart = wordClickStartRef.current;
          wordClickStartRef.current = null;
          if (clickStart && Math.hypot(event.clientX - clickStart.x, event.clientY - clickStart.y) > 6) {
            return;
          }
          const textTarget = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-text]");
          if (textTarget) {
            const rect = textTarget.getBoundingClientRect();
            const raw = textTarget.dataset.text || "";
            const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
            const word = clickedWordFromTextSpan(raw, ratio, textTarget.dataset.combinedWord);
            if (word) {
              const sentenceId = textTarget.dataset.sentenceId;
              const sentence = sentenceId ? props.sentenceUnits.find((unit) => unit.id === sentenceId) : null;
              const shell = textTarget.closest<HTMLElement>(".pdf-page-shell");
              const shellRect = shell?.getBoundingClientRect();
              const side = shellRect && event.clientX < shellRect.left + shellRect.width / 2 ? "left" : "right";
              props.onWordSelect({
                word,
                page: props.pageNumber,
                sourceSentenceId: sentenceId,
                context: sentence?.source || raw,
                x: side === "left" ? rect.left - 12 : rect.right + 12,
                y: rect.top + rect.height / 2,
                side,
              });
            }
          }
        }}
      />
    </div>
  );
}
