import { Languages, Library, ListTree, PanelRight, Search, Settings, Share2, X, ZoomIn, ZoomOut } from "./icons";
import type { DocumentRecord, WorkspaceMode } from "../types";
import type { UiStrings } from "../lib/uiStrings";
type TopToolbarProps = {
  ui: UiStrings;
  mode: WorkspaceMode;
  document: DocumentRecord | null;
  zoom: number;
  pageCursor: number;
  pageCount: number;
  searchTerm: string;
  busy: boolean;
  outlineOpen: boolean;
  rightPanelOpen: boolean;
  shareReady: boolean;
  onOpenLibrary: () => void;
  onOpenSettings: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomChange: (zoom: number) => void;
  onPageChange: (page: number) => void;
  onSearch: (value: string) => void;
  onTogglePanel: () => void;
  onToggleTranslationPanel: () => void;
  onShowOutline: () => void;
  onStartRegionExplain: () => void;
  onTranslatePage: () => void;
  onToggleAutoTranslate: () => void;
  onShareFile: () => void;
  autoTranslate: boolean;
  translationPanelOpen: boolean;
};

export function TopToolbar(props: TopToolbarProps) {
  const title =
    props.mode === "reader"
      ? props.document?.title || "Paper Pilot"
      : props.mode === "library"
        ? props.ui.library
        : props.ui.settings;
  const zoomPercent = Math.round(props.zoom * 100);
  const zoomOptions = [80, 100, 105, 113, 125, 150, 175, 200, 250, 300, 400, 500, 750, 1000];
  const resolvedZoomOptions = zoomOptions.includes(zoomPercent)
    ? zoomOptions
    : [...zoomOptions, zoomPercent].sort((a, b) => a - b);
  return (
    <header className="top-toolbar">
      <div className="toolbar-document">
        <button title={props.ui.library} data-tooltip={props.ui.library} aria-label={props.ui.library} className={props.mode === "library" ? "toolbar-icon active" : "toolbar-icon"} onClick={props.onOpenLibrary}>
          <Library size={17} />
        </button>
        {props.mode === "reader" && (
          <div className="toolbar-reader-toggles" aria-label="Reader panels">
            <button
              title={props.outlineOpen ? props.ui.closeOutline : props.ui.openOutline}
              data-tooltip={props.outlineOpen ? props.ui.closeOutline : props.ui.openOutline}
              aria-label={props.outlineOpen ? props.ui.closeOutline : props.ui.openOutline}
              className={props.outlineOpen ? "toolbar-icon active" : "toolbar-icon"}
              onClick={props.onShowOutline}
            >
              <ListTree size={17} />
            </button>
            <button
              title={props.translationPanelOpen ? props.ui.closeTranslationPanel : props.ui.openTranslationPanel}
              data-tooltip={props.translationPanelOpen ? props.ui.closeTranslationPanel : props.ui.openTranslationPanel}
              aria-label={props.translationPanelOpen ? props.ui.closeTranslationPanel : props.ui.openTranslationPanel}
              className={props.translationPanelOpen ? "toolbar-icon active" : "toolbar-icon"}
              onClick={props.onToggleTranslationPanel}
            >
              <Languages size={17} />
            </button>
          </div>
        )}
        <div className="toolbar-title-copy">
          <span>{props.mode === "reader" ? props.ui.page : "Paper Pilot"}</span>
          <strong>{title}</strong>
        </div>
      </div>
      <div className={props.mode === "reader" ? "toolbar-actions" : "toolbar-actions toolbar-actions-empty"}>
        {props.mode === "reader" && (
          <>
            <select
              className="zoom-select"
              value={zoomPercent}
              onChange={(event) => props.onZoomChange(Number(event.target.value) / 100)}
              title={props.ui.zoom}
            >
              {resolvedZoomOptions.map((value) => (
                <option key={value} value={value}>{value}%</option>
              ))}
            </select>
            <button title={props.ui.zoomOut} data-tooltip={props.ui.zoomOut} aria-label={props.ui.zoomOut} className="toolbar-icon" onClick={props.onZoomOut}>
              <ZoomOut size={16} />
            </button>
            <button title={props.ui.zoomIn} data-tooltip={props.ui.zoomIn} aria-label={props.ui.zoomIn} className="toolbar-icon" onClick={props.onZoomIn}>
              <ZoomIn size={16} />
            </button>
            <input
              className="toolbar-page-input"
              type="number"
              min={1}
              max={Math.max(1, props.pageCount)}
              value={props.pageCursor}
              onChange={(event) => props.onPageChange(Number(event.target.value))}
              title={props.ui.page}
            />
            <span className="toolbar-page-total">/ {Math.max(1, props.pageCount)}</span>
            <div className="toolbar-search" title={props.ui.search}>
              <Search size={17} />
              <input
                value={props.searchTerm}
                placeholder={props.ui.search}
                onChange={(event) => props.onSearch(event.target.value)}
              />
              {props.searchTerm && (
                <button type="button" title={props.ui.dismissMessage} onClick={() => props.onSearch("")}>
                  <X size={13} />
                </button>
              )}
            </div>
          </>
        )}
      </div>
      <div className="toolbar-trailing">
        <button title={props.ui.shareTranslatedPdf} data-tooltip={props.ui.shareTranslatedPdf} aria-label={props.ui.shareTranslatedPdf} className="toolbar-icon" onClick={props.onShareFile} disabled={!props.shareReady}>
          <Share2 size={17} />
        </button>
        {props.mode === "reader" && (
          <button
            title={props.rightPanelOpen ? props.ui.closeRightPanel : props.ui.openRightPanel}
            data-tooltip={props.rightPanelOpen ? props.ui.closeRightPanel : props.ui.openRightPanel}
            aria-label={props.rightPanelOpen ? props.ui.closeRightPanel : props.ui.openRightPanel}
            className={props.rightPanelOpen ? "toolbar-icon active" : "toolbar-icon"}
            onClick={props.onTogglePanel}
          >
            <PanelRight size={17} />
          </button>
        )}
        <button title={props.ui.settings} data-tooltip={props.ui.settings} aria-label={props.ui.settings} className={props.mode === "settings" ? "toolbar-icon active" : "toolbar-icon"} onClick={props.onOpenSettings}>
          <Settings size={17} />
        </button>
        {props.busy && <span className="busy-pill">{props.ui.working}</span>}
      </div>
    </header>
  );
}
