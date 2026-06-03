import type { CSSProperties, Dispatch, MouseEvent, MouseEventHandler, PointerEvent, RefObject, SetStateAction } from "react";
import { EmptyReader } from "../LibraryViews";
import { ReaderActionPalette, ReaderOutline, ReaderRail } from "../ReaderChrome";
import { RightPanel, type ReaderAssistantMode } from "../panels/ReaderPanels";
import { setSetting, upsertAnnotation, deleteCitationCard, upsertCitationCard } from "../../lib/tauri";
import { sentenceUnitsForPage, translationResultForPage, type TranslationUnit } from "../../lib/translations";
import { wordMeaningLookupEnabled } from "../../lib/appState";
import { wordMeaningLookupEnabledSettingKey, type WordPopup } from "../../lib/wordMeanings";
import type { DocumentTextLayoutMode, SelectionToolbar } from "../../lib/pdfText";
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
          Array.from({ length: props.pdfDocument.numPages }, (_, index) => index + 1).map((pageNumber) => (
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
                  : props.selectionToolbar?.page === pageNumber
                    ? props.selectionToolbar.rects
                    : []
              }
              textLayoutMode={props.activeDocumentTextLayoutMode}
              onWordSelect={props.onOpenWordMeaningPopup}
              regionDrag={props.regionDrag}
              onTextReady={props.onCreatePageText}
              onOutlineReady={props.onRememberOutlineAnchors}
              onImageReady={props.onRememberPageImage}
              onOpenExplanation={props.onOpenExplanation}
              onDeleteAnnotation={(id) => props.onDeleteAnnotationById(id)}
              onPreviewLink={(target) => props.onOpenLinkPreview(target)}
            />
          ))}
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
