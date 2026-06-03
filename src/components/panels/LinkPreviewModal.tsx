import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Link, Move, RefreshCw, Sparkles, X, ZoomIn, ZoomOut } from "../icons";
import { FormattedAiText } from "../FormattedAiText";
import { hostFromUrl, type LinkPreviewState } from "../../lib/linkPreviews";
import { clampNumber } from "../../lib/readerSettings";
import { useUiStrings } from "../../lib/uiStrings";

export function LinkPreviewModal(props: {
  preview: LinkPreviewState | null;
  loading: boolean;
  onClose: () => void;
  onGo: (preview: LinkPreviewState) => void;
  onSummarize: (preview: LinkPreviewState) => void;
}) {
  const ui = useUiStrings();
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  useEffect(() => {
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    dragRef.current = null;
  }, [props.preview]);

  const startPan = (event: PointerEvent<HTMLDivElement>) => {
    if (props.preview?.kind !== "internal") {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
  };
  const movePan = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    setOffset({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    });
  };
  const stopPan = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }
  };

  const title =
    props.preview?.kind === "internal"
      ? `${props.preview.title || `${ui.page} ${props.preview.targetPage}`} ${ui.preview}`
      : props.preview?.title || ui.linkPreview;

  return (
    <div
      className="link-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={ui.linkPreview}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
    >
      <section className="link-preview-card">
        <header className="link-preview-head">
          <div>
            <strong>{title}</strong>
            {props.preview && <span>{ui.sourcePage} {props.preview.sourcePage}</span>}
          </div>
          <button title={ui.close} onClick={props.onClose}>
            <X size={17} />
          </button>
        </header>

        {props.loading && (
          <div className="link-preview-loading">
            <RefreshCw size={18} />
            <span>{ui.preparingPreview}</span>
          </div>
        )}

        {!props.loading && props.preview?.kind === "internal" && (
          <>
            {(props.preview.referenceText || props.preview.excerpt) && (
              <div className="reference-preview-context">
                {props.preview.referenceText && <strong>{props.preview.referenceText}</strong>}
                {props.preview.excerpt && <p>{props.preview.excerpt}</p>}
              </div>
            )}
            <div className="link-preview-controls">
              <button title={ui.zoomOut} onClick={() => setZoom((value) => Math.max(0.65, Math.round((value - 0.15) * 100) / 100))}>
                <ZoomOut size={15} />
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button title={ui.zoomIn} onClick={() => setZoom((value) => Math.min(2.8, Math.round((value + 0.15) * 100) / 100))}>
                <ZoomIn size={15} />
              </button>
              <button title={ui.resetPosition} onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}>
                <Move size={15} />
              </button>
            </div>
            <div
              className={props.preview.previewMode === "region" ? "link-preview-stage region-preview" : "link-preview-stage"}
              onPointerDown={startPan}
              onPointerMove={movePan}
              onPointerUp={stopPan}
              onPointerCancel={stopPan}
              onWheel={(event) => {
                event.preventDefault();
                const delta = event.deltaY > 0 ? -0.08 : 0.08;
                setZoom((value) => clampNumber(Math.round((value + delta) * 100) / 100, 0.65, 2.8));
              }}
            >
              <img
                src={props.preview.imageDataUrl}
                alt={`${ui.page} ${props.preview.targetPage} ${ui.preview}`}
                draggable={false}
                style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}
              />
            </div>
          </>
        )}

        {!props.loading && props.preview?.kind === "external" && (
          <div className="external-preview-body">
            <div className="external-preview-host">
              <Link size={18} />
              <div>
                <strong>{hostFromUrl(props.preview.url)}</strong>
                <span>{props.preview.url}</span>
              </div>
            </div>
            <FormattedAiText text={props.preview.summary} compact />
          </div>
        )}

        {props.preview && (
          <footer className="link-preview-actions">
            {props.preview.kind === "external" && (
              <button onClick={() => props.preview && props.onSummarize(props.preview)}>
                <Sparkles size={14} />
                {ui.aiSummary}
              </button>
            )}
            <button onClick={props.onClose}>{ui.close}</button>
            <button className="primary" onClick={() => props.preview && props.onGo(props.preview)}>
              {props.preview.kind === "external" ? ui.goToLink : ui.goToPage}
            </button>
          </footer>
        )}
      </section>
    </div>
  );
}
