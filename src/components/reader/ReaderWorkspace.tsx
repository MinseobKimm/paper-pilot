import { useEffect, useMemo, useState, type CSSProperties, type Dispatch, type MouseEvent, type MouseEventHandler, type PointerEvent, type RefObject, type SetStateAction } from "react";
import { EmptyReader } from "../LibraryViews";
import { ReaderActionPalette, ReaderOutline, ReaderRail } from "../ReaderChrome";
import { RightPanel, type ReaderAssistantMode } from "../panels/ReaderPanels";
import { setSetting, upsertAnnotation, deleteCitationCard, upsertCitationCard } from "../../lib/tauri";
import { sentenceUnitsForPage, translationResultForPage, type TranslationUnit } from "../../lib/translations";
import { wordMeaningLookupEnabled } from "../../lib/appState";
import { wordMeaningLookupEnabledSettingKey, type WordPopup } from "../../lib/wordMeanings";
import type { DocumentTextLayoutMode, PageTextLayoutInference, SelectionToolbar } from "../../lib/pdfText";
import type { OutlineAnchor, OutlineRow } from "../../lib/outlines";
import type { PdfDocumentProxy } from "../../lib/pdfDocument";
import type { PdfLinkPreviewTarget } from "../../lib/linkPreviews";
import type {
  AiResultRecord,
  AiTaskType,
  AnnotationRecord,
  AppStateRecord,
  CitationCardRecord,
  DocumentRecord,
  NoteRecord,
  PageRecord,
  PanelTab,
} from "../../types";
import type { UiStrings } from "../../lib/uiStrings";
import type { ReaderMarkupTool } from "../../hooks/useReaderSelection";
import { PdfPageView } from "./PdfPageView";
import { TranslationSidecar } from "./TranslationSidecar";

type RegionDrag = {
  page: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  width: number;
  height: number;
} | null;

type ReaderWorkspaceProps = {
  ui: UiStrings;
  state: AppStateRecord;
  activePanel: PanelTab;
  setActivePanel: (tab: PanelTab) => void;
  activeDocument: DocumentRecord | null;
  activePages: PageRecord[];
  activeAnnotations: AnnotationRecord[];
  activeAiResults: AiResultRecord[];
  activeCitations: CitationCardRecord[];
  activeNote: NoteRecord | null;
  activeOutlineRows: OutlineRow[];
  activeOutlineId: string | null;
  activeDocumentWordList: string[];
  activeDocumentTextLayoutMode: DocumentTextLayoutMode | "";
  activePageTextLayoutModes: Record<number, DocumentTextLayoutMode | "">;
  currentPage: PageRecord | undefined;
  currentTranslationUnits: TranslationUnit[];
  selectedSentenceId: string | null;
  selectedSentenceIds: string[];
  missingWordCount: number;
  pdfDocument: PdfDocumentProxy | null;
  pageCursor: number;
  pageImages: Record<number, string>;
  pageMatches: number[];
  zoom: number;
  searchTerm: string;
  hoverSource: string | null;
  readerRef: RefObject<HTMLDivElement>;
  readerGridStyle: CSSProperties;
  outlineOpen: boolean;
  setOutlineOpen: Dispatch<SetStateAction<boolean>>;
  outlineCompact: boolean;
  setOutlineCompact: Dispatch<SetStateAction<boolean>>;
  translationPanelOpen: boolean;
  setTranslationPanelOpen: Dispatch<SetStateAction<boolean>>;
  rightPanelOpen: boolean;
  setRightPanelOpen: Dispatch<SetStateAction<boolean>>;
  translationLanguageName: string;
  markupTool: ReaderMarkupTool;
  setMarkupTool: Dispatch<SetStateAction<ReaderMarkupTool>>;
  regionMode: boolean;
  setRegionMode: Dispatch<SetStateAction<boolean>>;
  regionDrag: RegionDrag;
  textSelectionPreview: { page: number; rects: AnnotationRecord["rects"] } | null;
  selectionToolbar: SelectionToolbar | null;
  assistantMode: ReaderAssistantMode;
  setAssistantMode: (mode: ReaderAssistantMode) => void;
  chatDraft: string;
  setChatDraft: (value: string) => void;
  folders: AppStateRecord["folders"];
  onPickFile: () => void;
  onLoadActiveDocument: (document: DocumentRecord) => void;
  onShowToast: (message: string, kind?: "info" | "error") => void;
  onPatchState: (mutator: (draft: AppStateRecord) => void) => void;
  onStartLayoutResize: (area: "outline" | "translation" | "rightPanel", event: PointerEvent) => void;
  onGoToPage: (page: number) => void;
  onGoToOutlineRow: (row: OutlineRow) => void;
  onSelectSentenceAndScroll: (id: string) => void;
  onRefreshTranslationForPage: (page: PageRecord) => void;
  onScheduleHorizontalScrollSave: (scrollLeft: number) => void;
  onScheduleReaderCursorSync: (element: HTMLDivElement) => void;
  onHandleRegionMouseDown: MouseEventHandler<HTMLDivElement>;
  onHandleRegionMouseMove: MouseEventHandler<HTMLDivElement>;
  onFinishRegionExplain: (event: MouseEvent<HTMLDivElement>) => void | Promise<void>;
  onCreatePageText: (page: PageRecord) => void;
  onRememberPageTextLayout: (pageNumber: number, inference: PageTextLayoutInference) => void;
  onRememberOutlineAnchors: (pageNumber: number, rows: OutlineAnchor[]) => void;
  onRememberPageImage: (pageNumber: number, dataUrl: string) => void;
  onOpenExplanation: (annotation: AnnotationRecord) => void;
  onDeleteAnnotationById: (id: string) => void;
  onOpenLinkPreview: (target: PdfLinkPreviewTarget) => void;
  onOpenWordMeaningPopup: (popup: WordPopup) => void;
  onQueueTask: (type: AiTaskType, payload: Record<string, unknown>) => void;
  onRunPendingBridgeWorkers: () => void;
  onPollBridge: () => void;
  onDeleteAllActiveAnnotations: () => void;
  onDeleteExplanationResult: (result: AiResultRecord) => void;
  onExtractCitationCards: () => void;
  onResolveCitationLinks: () => void;
  onSaveNote: (markdown: string) => Promise<void>;
  onDeleteActiveNote: () => Promise<void>;
  onUpdateMetadata: (field: keyof DocumentRecord, value: string | boolean | null) => void;
  onMoveActiveDocument: (folderId: string) => void;
  onExportJson: () => void;
  onExportZip: () => void;
  onCopyText: (text: string, label: string) => void;
  onHoverSource: (value: string | null) => void;
  onCreateMissingWordMeanings: () => void;
  onShareAnnotatedFile: () => void;
  onToggleWordPopupClosed: () => void;
};

export function ReaderWorkspace(props: ReaderWorkspaceProps) {
  const pageCount = props.pdfDocument?.numPages ?? props.activeDocument?.pageCount ?? 0;
  const autoTranslate = props.state.settings.autoTranslate === "true";
  const pageNumbers = useMemo(() => Array.from({ length: pageCount }, (_, index) => index + 1), [pageCount]);
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set());
  const estimatedPageWidth = Math.round(612 * props.zoom);
  const estimatedPageHeight = Math.round(792 * props.zoom);

  function nearbyPages(page: number) {
    const pages: number[] = [];
    for (let offset = -2; offset <= 3; offset += 1) {
      const next = page + offset;
      if (next >= 1 && next <= pageCount) {
        pages.push(next);
      }
    }
    return pages;
  }

  useEffect(() => {
    if (!props.activeDocument || pageCount <= 0) {
      setRenderedPages(new Set());
      return;
    }
    setRenderedPages(new Set(nearbyPages(props.pageCursor)));
  }, [props.activeDocument?.id, pageCount, props.zoom]);

  useEffect(() => {
    if (!props.activeDocument || pageCount <= 0) {
      return;
    }
    const nextPages = nearbyPages(props.pageCursor);
    setRenderedPages((current) => {
      if (nextPages.every((page) => current.has(page))) {
        return current;
      }
      const next = new Set(current);
      nextPages.forEach((page) => next.add(page));
      return next;
    });
  }, [props.activeDocument?.id, pageCount, props.pageCursor]);

  useEffect(() => {
    const root = props.readerRef.current;
    if (!root || !props.activeDocument || pageCount <= 0) {
      return;
    }
    const placeholders = Array.from(root.querySelectorAll<HTMLElement>(".pdf-page-placeholder"));
    if (placeholders.length === 0) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visiblePages = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => Number((entry.target as HTMLElement).dataset.page ?? 0))
          .filter((page) => page > 0);
        if (visiblePages.length === 0) {
          return;
        }
        setRenderedPages((current) => {
          const next = new Set(current);
          visiblePages.forEach((page) => next.add(page));
          return next.size === current.size ? current : next;
        });
      },
      { root, rootMargin: "900px 0px" },
    );
    placeholders.forEach((placeholder) => observer.observe(placeholder));
    return () => observer.disconnect();
  }, [props.activeDocument?.id, pageCount, renderedPages, props.readerRef]);

  function toggleAutoTranslate() {
    const next = autoTranslate ? "false" : "true";
    props.onPatchState((draft) => {
      draft.settings.autoTranslate = next;
    });
    void setSetting("autoTranslate", next);
  }

  function toggleWordMeaningLookup() {
    const next = wordMeaningLookupEnabled(props.state.settings) ? "false" : "true";
    props.onPatchState((draft) => {
      draft.settings[wordMeaningLookupEnabledSettingKey] = next;
    });
    if (next === "false") {
      props.onToggleWordPopupClosed();
    }
    void setSetting(wordMeaningLookupEnabledSettingKey, next);
  }

  return (
    <section
      className={[
        "reader-grid",
        !props.outlineOpen ? "outline-closed" : "",
        !props.rightPanelOpen ? "panel-closed" : "",
        !props.translationPanelOpen ? "translation-closed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={props.readerGridStyle}
    >
      <ReaderRail
        ui={props.ui}
        outlineOpen={props.outlineOpen}
        translationPanelOpen={props.translationPanelOpen}
        rightPanelOpen={props.rightPanelOpen}
        onShowOutline={() => {
          props.setOutlineOpen((value) => !value);
          props.setOutlineCompact(false);
        }}
        onToggleTranslationPanel={() => props.setTranslationPanelOpen((value) => !value)}
        onTogglePanel={() => props.setRightPanelOpen((value) => !value)}
      />
      {props.outlineOpen && (
        <ReaderOutline
          compact={props.outlineCompact}
          document={props.activeDocument}
          pages={props.activePages}
          rows={props.activeOutlineRows}
          pageCursor={props.pageCursor}
          activeRowId={props.activeOutlineId}
          onCompact={props.setOutlineCompact}
          onClose={() => props.setOutlineOpen(false)}
          onResizeStart={(event) => props.onStartLayoutResize("outline", event)}
          onGoToRow={props.onGoToOutlineRow}
        />
      )}
      {props.translationPanelOpen && (
        <TranslationSidecar
          ui={props.ui}
          translationLanguageName={props.translationLanguageName}
          page={props.pageCursor}
          pageCount={pageCount}
          units={props.currentTranslationUnits}
          selectedSentenceId={props.selectedSentenceId}
          pending={Boolean(translationResultForPage(props.activeAiResults, props.currentPage, props.translationLanguageName)?.status === "pending")}
          autoTranslate={autoTranslate}
          onSelectSentence={props.onSelectSentenceAndScroll}
          onRefresh={() => props.currentPage && props.onRefreshTranslationForPage(props.currentPage)}
          onTranslatePage={() => props.currentPage && props.onRefreshTranslationForPage(props.currentPage)}
          onResizeStart={(event) => props.onStartLayoutResize("translation", event)}
          onClose={() => props.setTranslationPanelOpen(false)}
        />
      )}
      <div
        ref={props.readerRef}
        className={[
          "pdf-stage",
          props.regionMode ? "region-mode" : "",
          props.markupTool.kind === "erase" ? "highlight-erase-mode" : "",
          props.markupTool.kind === "highlight" ? "highlight-paint-mode" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onMouseDown={props.onHandleRegionMouseDown}
        onMouseMove={props.onHandleRegionMouseMove}
        onMouseUp={(event) => void props.onFinishRegionExplain(event)}
        onScroll={(event) => {
          props.onScheduleHorizontalScrollSave(event.currentTarget.scrollLeft);
          props.onScheduleReaderCursorSync(event.currentTarget);
        }}
      >
        <ReaderActionPalette
          ui={props.ui}
          markupTool={props.markupTool}
          autoTranslate={autoTranslate}
          wordMeaningLookupEnabled={wordMeaningLookupEnabled(props.state.settings)}
          wordListCount={props.activeDocumentWordList.length}
          missingWordCount={props.missingWordCount}
          onSelectHighlightColor={(color) =>
            props.setMarkupTool((current) =>
              current.kind === "highlight" && current.color === color ? { kind: "none" } : { kind: "highlight", color },
            )
          }
          onSelectEraser={() =>
            props.setMarkupTool((current) => (current.kind === "erase" ? { kind: "none" } : { kind: "erase" }))
          }
          onStartRegionExplain={() => {
            props.setRegionMode(true);
            props.onShowToast(props.ui.dragRegionPrompt);
          }}
          onToggleAutoTranslate={toggleAutoTranslate}
          onToggleWordMeaningLookup={toggleWordMeaningLookup}
          onBuildWordMeanings={props.onCreateMissingWordMeanings}
        />
        {!props.activeDocument && <EmptyReader onPickFile={props.onPickFile} />}
        {props.activeDocument && !props.pdfDocument && (
          <EmptyReader
            label={props.ui.openStoredPdf}
            hint={props.ui.selectedDocumentNeedsLoad}
            onPickFile={() => props.activeDocument && props.onLoadActiveDocument(props.activeDocument)}
          />
        )}
        {props.pdfDocument &&
          props.activeDocument &&
          pageNumbers.map((pageNumber) => {
            const textLayoutMode = props.activePageTextLayoutModes[pageNumber] || props.activeDocumentTextLayoutMode;
            if (!renderedPages.has(pageNumber)) {
              const pageLayoutClass =
                textLayoutMode === "single" ? "layout-single" : textLayoutMode === "two-column" ? "layout-two-column" : "layout-auto";
              return (
                <div
                  key={`${props.activeDocument?.id}-${pageNumber}-placeholder-${props.zoom}`}
                  id={`page-${pageNumber}`}
                  className={`pdf-page-shell pdf-page-placeholder ${pageLayoutClass}`}
                  data-page={pageNumber}
                  data-text-layout={textLayoutMode || "auto"}
                  style={{ width: estimatedPageWidth, minHeight: estimatedPageHeight }}
                >
                  <div className="page-label">Page {pageNumber}</div>
                </div>
              );
            }
            return (
              <PdfPageView
                key={`${props.activeDocument?.id}-${pageNumber}-${props.zoom}`}
                pdf={props.pdfDocument!}
                documentId={props.activeDocument!.id}
                pageNumber={pageNumber}
                zoom={props.zoom}
                searchTerm={props.searchTerm}
                referencePages={props.activePages}
                annotations={props.activeAnnotations.filter((annotation) => annotation.page === pageNumber)}
                hoverSource={props.hoverSource}
                sentenceUnits={sentenceUnitsForPage(props.activePages.find((page) => page.pageNumber === pageNumber))}
                selectedSentenceIds={props.selectedSentenceIds}
                highlightEraseActive={props.markupTool.kind === "erase"}
                selectionPreviewRects={
                  props.textSelectionPreview?.page === pageNumber
                    ? props.textSelectionPreview.rects
                    : []
                }
                textLayoutMode={textLayoutMode}
                onTextLayoutReady={props.onRememberPageTextLayout}
                onWordSelect={props.onOpenWordMeaningPopup}
                regionDrag={props.regionDrag}
                onTextReady={props.onCreatePageText}
                onOutlineReady={props.onRememberOutlineAnchors}
                onImageReady={props.onRememberPageImage}
                captureImage={false}
                onOpenExplanation={props.onOpenExplanation}
                onDeleteAnnotation={(id) => props.onDeleteAnnotationById(id)}
                onPreviewLink={(target) => props.onOpenLinkPreview(target)}
              />
            );
          })}
      </div>
      {props.rightPanelOpen && (
        <RightPanel
          tab={props.activePanel}
          setTab={props.setActivePanel}
          document={props.activeDocument}
          pages={props.activePages}
          annotations={props.activeAnnotations}
          aiResults={props.activeAiResults}
          citations={props.activeCitations}
          note={props.activeNote}
          settings={props.state.settings}
          outlineRows={props.activeOutlineRows}
          searchMatches={props.pageMatches}
          onQueueTask={props.onQueueTask}
          onRunBridge={props.onRunPendingBridgeWorkers}
          onPollBridge={props.onPollBridge}
          onStartRegionExplain={() => {
            props.setRegionMode(true);
            props.onShowToast(props.ui.dragRegionPrompt);
          }}
          onUpdateAnnotation={(annotation) =>
            void upsertAnnotation(annotation).then((saved) =>
              props.onPatchState((draft) => {
                draft.annotations = [saved, ...draft.annotations.filter((item) => item.id !== saved.id)];
              }),
            )
          }
          onDeleteAnnotation={props.onDeleteAnnotationById}
          onDeleteAllAnnotations={props.onDeleteAllActiveAnnotations}
          onDeleteExplanation={props.onDeleteExplanationResult}
          onGoToPage={props.onGoToPage}
          onExtractCitations={props.onExtractCitationCards}
          onResolveCitationLinks={props.onResolveCitationLinks}
          onDeleteCitation={(id) =>
            void deleteCitationCard(id).then(() =>
              props.onPatchState((draft) => {
                draft.citationCards = draft.citationCards.filter((item) => item.id !== id);
              }),
            )
          }
          onSaveCitation={(card) =>
            void upsertCitationCard(card).then((saved) =>
              props.onPatchState((draft) => {
                draft.citationCards = [saved, ...draft.citationCards.filter((item) => item.id !== saved.id)];
              }),
            )
          }
          onSaveNote={props.onSaveNote}
          onDeleteNote={props.onDeleteActiveNote}
          onMetadata={props.onUpdateMetadata}
          onMoveFolder={props.onMoveActiveDocument}
          folders={props.folders}
          onJsonExport={props.onExportJson}
          onZipExport={props.onExportZip}
          onCopy={props.onCopyText}
          onHoverSource={props.onHoverSource}
          chatDraft={props.chatDraft}
          setChatDraft={props.setChatDraft}
          assistantMode={props.assistantMode}
          setAssistantMode={props.setAssistantMode}
          pageCursor={props.pageCursor}
          pageImages={props.pageImages}
          onResizeStart={(event) => props.onStartLayoutResize("rightPanel", event)}
          onClose={() => props.setRightPanelOpen(false)}
        />
      )}
    </section>
  );
}
