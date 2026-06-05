export type PanelTab = "ai" | "activity" | "citations" | "notes" | "info";
export type WorkspaceMode = "library" | "reader" | "settings";
export type AiProviderKind = "codex-cli" | "claude-code" | "local-draft";
export type AgentProviderStatus = {
  provider: AiProviderKind | string;
  installed: boolean | null;
  command?: string;
  source?: string;
  message: string;
};
export type AiTaskType =
  | "explainText"
  | "explainRegionImage"
  | "translateText"
  | "translatePage"
  | "summarizePaper"
  | "chatWithPaper"
  | "autoHighlight"
  | "citationReason"
  | "externalLinkSummary"
  | "outlineDocument"
  | "classifyDocumentLayout"
  | "recommendPapers"
  | "defineWordMeanings";

export type FolderRecord = {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string;
};

export type DocumentRecord = {
  id: string;
  title: string;
  fileName: string;
  filePath: string;
  hash: string;
  pageCount: number;
  authors: string;
  year: string;
  abstractText: string;
  folderId: string | null;
  bookmarked: boolean;
  createdAt: string;
  updatedAt: string;
};

export type PageRecord = {
  documentId: string;
  pageNumber: number;
  text: string;
  outlineLabel: string;
};

export type DocumentPageCapsule = {
  pageNumber: number;
  outlineLabel: string;
  detectedTitle: string;
  charCount: number;
  start: string;
  end: string;
  hasText: boolean;
};

export type DocumentContextPack = {
  documentId: string;
  title: string;
  pageCount: number;
  extractedPageCount: number;
  totalTextChars: number;
  outline: Array<{
    pageNumber: number;
    title: string;
    level: number;
    source: string;
  }>;
  pages: DocumentPageCapsule[];
};

export type AnnotationRecord = {
  id: string;
  documentId: string;
  page: number;
  kind: "manual" | "auto" | "translation" | "citation";
  color: string;
  text: string;
  rangeHint: string;
  rects: HighlightRect[];
  comment: string;
  tag: string;
  createdAt: string;
};

export type HighlightRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  basisWidth?: number;
  basisHeight?: number;
};

export type CommentRecord = {
  id: string;
  annotationId: string;
  documentId: string;
  page: number;
  text: string;
  createdAt: string;
};

export type NoteRecord = {
  id: string;
  documentId: string;
  markdown: string;
  updatedAt: string;
};

export type AiResultRecord = {
  id: string;
  documentId: string;
  taskType: AiTaskType | string;
  inputText: string;
  outputText: string;
  status: "pending" | "complete" | "failed" | "partial" | string;
  createdAt: string;
  provider?: AiProviderKind | string;
  model?: string;
  reasoningEffort?: string;
  providerSessionId?: string;
};

export type CitationCardRecord = {
  id: string;
  documentId: string;
  rawReference: string;
  title: string;
  authors: string;
  year: string;
  doi: string;
  url: string;
  reason: string;
  bibtex: string;
  createdAt: string;
};

export type RecommendationRunRecord = {
  id: string;
  folderId: string;
  query: string;
  resultJson: string;
  createdAt: string;
};

export type AppStateRecord = {
  folders: FolderRecord[];
  documents: DocumentRecord[];
  pages: PageRecord[];
  annotations: AnnotationRecord[];
  comments: CommentRecord[];
  notes: NoteRecord[];
  aiResults: AiResultRecord[];
  citationCards: CitationCardRecord[];
  recommendationRuns: RecommendationRunRecord[];
  settings: Record<string, string>;
};

export type BridgeTask = {
  id: string;
  taskType: AiTaskType | string;
  documentId: string;
  provider: AiProviderKind | string;
  model?: string;
  reasoningEffort?: string;
  providerSessionId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
  bridgeDir?: string;
  filePath?: string;
};

export type BridgeResult = {
  id: string;
  taskType: string;
  status: string;
  output: string;
  payload: Record<string, unknown>;
};

export type DocumentMarkdownResult = {
  documentId: string;
  markdownPath: string;
  sourcePath: string;
  reusedCache: boolean;
  converter: string;
};

export type BridgeWorkerRun = {
  started: boolean;
  taskId: string;
  pid: number | null;
  command: string;
  logPath: string;
  errorLogPath: string;
  finalLogPath: string;
  message: string;
};

export type ResetWorkspaceResult = {
  state: AppStateRecord;
  deletedPaths: string[];
  skippedPaths: string[];
};

export type ExportBundle = {
  document: DocumentRecord;
  pages: PageRecord[];
  annotations: AnnotationRecord[];
  comments: CommentRecord[];
  notes: NoteRecord[];
  aiResults: AiResultRecord[];
  citationCards: CitationCardRecord[];
  exportedAt: string;
};

export type PdfPageText = {
  pageNumber: number;
  text: string;
  outlineLabel: string;
};

export type LoadedPdf = {
  documentId: string;
  bytes: Uint8Array;
};
