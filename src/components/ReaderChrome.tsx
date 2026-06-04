import type { CSSProperties, PointerEvent } from "react";
import { BookOpen, Bookmark, ChevronLeft, Eraser, Grid2X2, Highlighter, Languages, List, Maximize2, Sparkles, X } from "./icons";
import { InlineMathText, OutlineTitleText } from "./FormattedAiText";
import type { DocumentRecord, PageRecord } from "../types";
import type { OutlineRow } from "../lib/outlines";
import { highlightColors } from "../lib/highlights";
import { clampNumber } from "../lib/readerSettings";
import { useUiStrings, type UiStrings } from "../lib/uiStrings";
import type { WordMeaningEntry, WordPopup } from "../lib/wordMeanings";

export type ReaderMarkupTool =
  | { kind: "none" }
  | { kind: "highlight"; color: string }
  | { kind: "erase" };
export function ReaderOutline(props: {
  compact: boolean;
  document: DocumentRecord | null;
  pages: PageRecord[];
  rows: OutlineRow[];
  pageCursor: number;
  activeRowId: string | null;
  onCompact: (value: boolean) => void;
  onClose: () => void;
  onResizeStart: (event: PointerEvent) => void;
  onGoToRow: (row: OutlineRow) => void;
}) {
  const ui = useUiStrings();
  const rows = props.rows;
  const sourceMeta = rows.some((row) => row.source === "ai")
    ? ` - ${ui.aiOutline}`
    : rows.some((row) => row.source === "pending")
      ? ` - ${ui.aiOutlinePending}`
      : "";
  return (
    <aside className={props.compact ? "reader-outline compact" : "reader-outline"}>
      <button className="panel-resizer right" title={ui.resizeOutline} onPointerDown={props.onResizeStart} />
      <div className="outline-controls">
        <button className={props.compact ? "outline-icon-button active" : "outline-icon-button"} title={ui.gridView} onClick={() => props.onCompact(true)}>
          <Grid2X2 size={17} />
        </button>
        <button className={!props.compact ? "outline-icon-button active" : "outline-icon-button"} title={ui.outlineView} onClick={() => props.onCompact(false)}>
          <List size={17} />
        </button>
      </div>
      <button className="outline-collapse" title={ui.closeOutline} onClick={props.onClose}>
        <ChevronLeft size={14} />
      </button>
      {props.compact ? (
        <nav className="outline-grid" aria-label={ui.pageGrid}>
          {rows.length === 0 && <p className="muted outline-empty">{ui.aiOutlinePending}</p>}
          {rows.map((row) => (
            <button
              key={`grid-${row.id}`}
              data-outline-row-id={row.id}
              className={row.id === props.activeRowId || (!props.activeRowId && row.page === props.pageCursor) ? "outline-grid-tile active" : "outline-grid-tile"}
              onClick={() => props.onGoToRow(row)}
              title={row.title}
            >
              <strong>{row.page}</strong>
              <span>
                <OutlineTitleText text={row.title} />
              </span>
            </button>
          ))}
        </nav>
      ) : (
        <>
          <div className="outline-paper-title">
            <strong>{props.document?.title || ui.untitledPaper}</strong>
            <span>
              {props.document ? `${props.document.pageCount || props.pages.length || "-"} ${ui.pages}` : ui.noDocument}
              {sourceMeta}
            </span>
          </div>
          <nav className="outline-list">
            {rows.length === 0 && <p className="muted outline-empty">{ui.aiOutlinePending}</p>}
            {rows.map((row) => (
              <button
                key={row.id}
                data-outline-row-id={row.id}
                className={row.id === props.activeRowId || (!props.activeRowId && row.page === props.pageCursor) ? "outline-entry active" : "outline-entry"}
                onClick={() => props.onGoToRow(row)}
                style={{ "--outline-level": row.level } as CSSProperties}
                title={row.title}
              >
                <span>
                  <b>
                    <OutlineTitleText text={row.title} />
                  </b>
                </span>
              </button>
            ))}
          </nav>
        </>
      )}
    </aside>
  );
}

export function ReaderActionPalette(props: {
  ui: UiStrings;
  markupTool: ReaderMarkupTool;
  autoTranslate: boolean;
  wordMeaningLookupEnabled: boolean;
  wordListCount: number;
  missingWordCount: number;
  readerBookmarkCount: number;
  onAddReaderBookmark: () => void;
  onSelectHighlightColor: (color: string) => void;
  onSelectEraser: () => void;
  onStartRegionExplain: () => void;
  onToggleAutoTranslate: () => void;
  onToggleWordMeaningLookup: () => void;
  onBuildWordMeanings: () => void;
}) {
  const wordMeaningTitle = props.wordListCount
    ? `${props.ui.buildWordMeanings} (${props.missingWordCount}/${props.wordListCount})`
    : props.ui.buildWordMeanings;
  const preparedColors = highlightColors.slice(0, 3);
  return (
    <div className="reader-action-palette" aria-label="Reader tools">
      <div className="markup-tool-group" aria-label={props.ui.highlight}>
        <Highlighter size={15} />
        <div className="highlight-color-stack">
          {preparedColors.map((color) => {
            const active = props.markupTool.kind === "highlight" && props.markupTool.color === color.value;
            return (
              <button
                key={color.value}
                className={active ? "floating-tool color-tool active" : "floating-tool color-tool"}
                title={`${props.ui.highlight} ${color.name}`}
                data-tooltip={`${props.ui.highlight} ${color.name}`}
                aria-label={`${props.ui.highlight} ${color.name}`}
                style={{ "--tool-color": color.value } as CSSProperties}
                onClick={() => props.onSelectHighlightColor(color.value)}
              />
            );
          })}
        </div>
        <button
          className={props.markupTool.kind === "erase" ? "floating-tool active" : "floating-tool"}
          title={props.ui.delete}
          data-tooltip={props.ui.delete}
          aria-label={props.ui.delete}
          onClick={props.onSelectEraser}
        >
          <Eraser size={16} />
        </button>
      </div>
      <button className="floating-tool" title={props.ui.explainImage} data-tooltip={props.ui.explainImage} aria-label={props.ui.explainImage} onClick={props.onStartRegionExplain}>
        <Maximize2 size={17} />
      </button>
      <button
        className="floating-tool with-badge"
        title={props.ui.addReaderBookmark}
        data-tooltip={props.ui.addReaderBookmark}
        aria-label={props.ui.addReaderBookmark}
        onClick={props.onAddReaderBookmark}
      >
        <Bookmark size={17} />
        {props.readerBookmarkCount > 0 && <span className="floating-badge">{Math.min(99, props.readerBookmarkCount)}</span>}
      </button>
      <button
        className={props.autoTranslate ? "floating-tool active" : "floating-tool"}
        title={props.ui.autoTranslate}
        data-tooltip={props.ui.autoTranslate}
        aria-label={props.ui.autoTranslate}
        onClick={props.onToggleAutoTranslate}
      >
        <Languages size={17} />
      </button>
      <button
        className={props.wordMeaningLookupEnabled ? "floating-tool active" : "floating-tool"}
        title={props.wordMeaningLookupEnabled ? props.ui.wordMeaningLookupOn : props.ui.wordMeaningLookupOff}
        data-tooltip={props.wordMeaningLookupEnabled ? props.ui.wordMeaningLookupOn : props.ui.wordMeaningLookupOff}
        aria-label={props.wordMeaningLookupEnabled ? props.ui.wordMeaningLookupOn : props.ui.wordMeaningLookupOff}
        onClick={props.onToggleWordMeaningLookup}
      >
        <BookOpen size={17} />
      </button>
      <button className="floating-tool with-badge" title={wordMeaningTitle} data-tooltip={wordMeaningTitle} aria-label={wordMeaningTitle} onClick={props.onBuildWordMeanings}>
        <Sparkles size={17} />
        {props.missingWordCount > 0 && <span className="floating-badge">{Math.min(99, props.missingWordCount)}</span>}
      </button>
    </div>
  );
}

export function WordMeaningPopup(props: {
  ui: UiStrings;
  popup: WordPopup;
  entries: WordMeaningEntry[];
  loading: boolean;
  onClose: () => void;
  onAdjust: () => void;
  onDeleteEntry: (entryId: string) => void;
}) {
  const top = clampNumber(props.popup.y, 72, Math.max(120, window.innerHeight - 220));
  const left =
    props.popup.side === "left"
      ? clampNumber(props.popup.x, 260, Math.max(280, window.innerWidth - 12))
      : clampNumber(props.popup.x, 12, Math.max(280, window.innerWidth - 280));
  return (
    <aside
      className={`word-meaning-popover ${props.popup.side}`}
      style={{ top, left }}
      aria-label={props.ui.wordMeanings}
    >
      <div className="word-meaning-head">
        <div>
          <strong>{props.popup.word}</strong>
        </div>
        <button title={props.ui.dismissMessage} type="button" onClick={props.onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="word-meaning-list">
        {props.entries.length === 0 && props.loading && (
          <div className="word-meaning-empty">
            <span>{props.ui.wordMeaningLoading}</span>
          </div>
        )}
        {props.entries.length === 0 && !props.loading && (
          <div className="word-meaning-empty">
            <span>{props.ui.wordMeaningNone}</span>
          </div>
        )}
        {props.entries.map((entry) => (
          <article key={entry.id} className="word-meaning-row">
            <div>
              <p>
                <InlineMathText text={entry.meaning} inlineOnly />
              </p>
            </div>
            <button type="button" title={props.ui.delete} aria-label={props.ui.delete} onClick={() => props.onDeleteEntry(entry.id)}>
              <X size={13} />
            </button>
          </article>
        ))}
      </div>
      <div className="word-meaning-actions">
        <button type="button" onClick={props.onAdjust}>
          <Sparkles size={14} />
          <span>{props.ui.adjustWordMeaning}</span>
        </button>
      </div>
    </aside>
  );
}
