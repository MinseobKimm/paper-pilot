import type { PointerEvent } from "react";
import { ListPlus, MessageSquare, PenLine, Quote, Sparkles, X } from "../icons";
import { AssistantPanel, type ReaderAssistantMode } from "./AssistantPanel";
import { ActivityPanel } from "./tabs/ActivityPanel";
import { CitationsPanel } from "./tabs/CitationsPanel";
import { InfoPanel } from "./tabs/InfoPanel";
import { NotesPanel } from "./tabs/NotesPanel";
import type { AiResultRecord, AiProviderKind, AiTaskType, AgentProviderStatus, AnnotationRecord, CitationCardRecord, DocumentRecord, FolderRecord, NoteRecord, PageRecord, PanelTab } from "../../types";
import type { OutlineRow } from "../../lib/outlines";
import { useUiStrings } from "../../lib/uiStrings";

export type { ReaderAssistantMode };
type RightPanelProps = {
  tab: PanelTab;
  setTab: (tab: PanelTab) => void;
  document: DocumentRecord | null;
  pages: PageRecord[];
  annotations: AnnotationRecord[];
  aiResults: AiResultRecord[];
  citations: CitationCardRecord[];
  note: NoteRecord | null;
  settings: Record<string, string>;
  outlineRows: OutlineRow[];
  searchMatches: number[];
  folders: FolderRecord[];
  chatDraft: string;
  setChatDraft: (value: string) => void;
  assistantMode: ReaderAssistantMode;
  setAssistantMode: (mode: ReaderAssistantMode) => void;
  pageCursor: number;
  pageImages: Record<number, string>;
  onQueueTask: (type: AiTaskType, payload: Record<string, unknown>) => void;
  onRunBridge: () => void;
  onPollBridge: () => void;
  onStartRegionExplain: () => void;
  onUpdateAnnotation: (annotation: AnnotationRecord) => void;
  onDeleteAnnotation: (id: string) => void;
  onDeleteAllAnnotations: () => void;
  onDeleteExplanation: (result: AiResultRecord) => void;
  onOpenExplanationResult: (result: AiResultRecord) => void;
  onGoToPage: (page: number) => void;
  onExtractCitations: () => void;
  onResolveCitationLinks: () => void;
  onDeleteCitation: (id: string) => void;
  onSaveCitation: (card: CitationCardRecord) => void;
  onSaveNote: (markdown: string) => Promise<void>;
  onDeleteNote: () => Promise<void>;
  onMetadata: (field: keyof DocumentRecord, value: string | boolean | null) => void;
  onMoveFolder: (folderId: string) => void;
  onJsonExport: () => void;
  onZipExport: () => void;
  onCopy: (text: string, label: string) => void;
  onHoverSource: (value: string | null) => void;
  onResizeStart: (event: PointerEvent) => void;
  onClose: () => void;
};

export function RightPanel(props: RightPanelProps) {
  const ui = useUiStrings();
  const fullText = props.pages.map((page) => page.text).join("\n\n");
  return (
    <aside className="right-panel">
      <button className="panel-resizer left" title={ui.resizeRightPanel} onPointerDown={props.onResizeStart} />
      <div className="assistant-toolbar">
        <button className={props.tab === "ai" && props.assistantMode === "study" ? "assistant-tool active" : "assistant-tool"} title={ui.studyTools} data-tooltip={ui.studyTools} aria-label={ui.studyTools} onClick={() => { props.setTab("ai"); props.setAssistantMode("study"); }}>
          <Sparkles size={17} />
        </button>
        <button className={props.tab === "activity" ? "assistant-tool active" : "assistant-tool"} title={ui.highlights} data-tooltip={ui.highlights} aria-label={ui.highlights} onClick={() => props.setTab("activity")}>
          <PenLine size={17} />
        </button>
        <button className={props.tab === "ai" && props.assistantMode === "quotes" ? "assistant-tool active" : "assistant-tool"} title={ui.citationCards} data-tooltip={ui.citationCards} aria-label={ui.citationCards} onClick={() => { props.setTab("ai"); props.setAssistantMode("quotes"); }}>
          <Quote size={17} />
        </button>
        <button className={props.tab === "notes" ? "assistant-tool active" : "assistant-tool"} title={ui.notes} data-tooltip={ui.notes} aria-label={ui.notes} onClick={() => props.setTab("notes")}>
          <MessageSquare size={17} />
        </button>
        <button className={props.tab === "citations" ? "assistant-tool active" : "assistant-tool"} title={ui.citations} data-tooltip={ui.citations} aria-label={ui.citations} onClick={() => props.setTab("citations")}>
          <ListPlus size={17} />
        </button>
        <button className="assistant-tool close" title={ui.close} data-tooltip={ui.close} aria-label={ui.close} onClick={props.onClose}>
          <X size={17} />
        </button>
      </div>
      <div className="panel-body">
        {!props.document && <p className="muted">{ui.openPdfForPanels}</p>}
        {props.document && props.tab === "ai" && (
          <AssistantPanel
            annotations={props.annotations}
            aiResults={props.aiResults}
            settings={props.settings}
            chatDraft={props.chatDraft}
            setChatDraft={props.setChatDraft}
            mode={props.assistantMode}
            onQueueTask={props.onQueueTask}
            onHoverSource={props.onHoverSource}
            onGoToPage={props.onGoToPage}
            onCopy={props.onCopy}
            onDeleteExplanation={props.onDeleteExplanation}
            onOpenExplanationResult={props.onOpenExplanationResult}
          />
        )}
        {props.document && props.tab === "activity" && (
          <ActivityPanel
            annotations={props.annotations}
            onUpdateAnnotation={props.onUpdateAnnotation}
            onDeleteAnnotation={props.onDeleteAnnotation}
            onDeleteAllAnnotations={props.onDeleteAllAnnotations}
            onGoToPage={props.onGoToPage}
          />
        )}
        {props.document && props.tab === "citations" && (
          <CitationsPanel
            document={props.document}
            citations={props.citations}
            onExtractCitations={props.onExtractCitations}
            onResolveCitationLinks={props.onResolveCitationLinks}
            onDeleteCitation={props.onDeleteCitation}
            onSaveCitation={props.onSaveCitation}
            onQueueTask={props.onQueueTask}
            onCopy={props.onCopy}
            onHoverSource={props.onHoverSource}
          />
        )}
        {props.document && props.tab === "notes" && (
          <NotesPanel note={props.note} fullText={fullText} onSaveNote={props.onSaveNote} onDeleteNote={props.onDeleteNote} />
        )}
        {props.document && props.tab === "info" && (
          <InfoPanel
            document={props.document}
            folders={props.folders}
            outlineRows={props.outlineRows}
            searchMatches={props.searchMatches}
            onMetadata={props.onMetadata}
            onMoveFolder={props.onMoveFolder}
            onGoToPage={props.onGoToPage}
            onJsonExport={props.onJsonExport}
            onZipExport={props.onZipExport}
          />
        )}
      </div>
    </aside>
  );
}
