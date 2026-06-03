import {
  Archive,
  BookOpen,
  Bot,
  Bookmark,
  BookmarkCheck,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Copy,
  Download,
  Eraser,
  Eye,
  FileArchive,
  FileText,
  FolderOpen,
  FolderPlus,
  Grid2X2,
  GripVertical,
  Highlighter,
  Languages,
  Library,
  Link,
  List,
  ListPlus,
  ListTree,
  Maximize2,
  MessageCircle,
  MessageSquare,
  MessageSquareText,
  MoreVertical,
  Move,
  PanelRight,
  PenLine,
  Quote,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "./components/icons";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import katex from "katex";
import "katex/dist/katex.min.css";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { isAgentProvider, normalizeAiProviderKind, runAiTask } from "./lib/ai";
import { citationCardsToBibtex, citationCardsToCsv, extractReferences } from "./lib/citations";
import { createAutoHighlights, highlightColors } from "./lib/highlights";
import { makeId, nowIso } from "./lib/ids";
import { buildRagContext } from "./lib/rag";
import { openExternalUrl, openPaperUrl, resolveCitationLink } from "./lib/scholarly";
import {
  deleteAnnotation,
  deleteAiResults,
  deleteCitationCard,
  deleteDocument,
  deleteFolders,
  deleteNote,
  exportDocumentJson,
  exportDocumentZip,
  getAgentProviderStatus,
  importPdf,
  isTauriRuntime,
  loadAppState,
  readBridgeResult,
  readDocumentBytes,
  resetWorkspaceFiles,
  savePdfFile,
  saveAiResult,
  savePages,
  setSetting,
  startBridgeWorker,
  updateDocument,
  upsertAnnotation,
  upsertComment,
  upsertCitationCard,
  upsertFolder,
  upsertNote,
} from "./lib/tauri";
import type {
  AiResultRecord,
  AiRetrievalPlan,
  AgentProviderStatus,
  AiProviderKind,
  AiTaskType,
  AnnotationRecord,
  AppStateRecord,
  CitationCardRecord,
  DocumentRecord,
  FolderRecord,
  HighlightRect,
  NoteRecord,
  PageRecord,
  PanelTab,
  DocumentContextPack,
  SelectedPageText,
  WorkspaceMode,
} from "./types";

(pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
  pdfWorkerUrl;

type PdfDocumentProxy = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  getOutline(): Promise<PdfOutlineItem[] | null>;
  getMetadata(): Promise<{ info?: { Title?: string; Author?: string; CreationDate?: string } }>;
  getDestination?(dest: string): Promise<unknown[] | null>;
  getPageIndex?(ref: unknown): Promise<number>;
};

type PdfOutlineItem = {
  title?: string;
  dest?: unknown;
  items?: PdfOutlineItem[];
};

type PdfPageProxy = {
  getViewport(options: { scale: number }): { width: number; height: number; transform: number[]; convertToViewportRectangle?: (rect: number[]) => number[] };
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
  getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }> }>;
  getAnnotations?(options?: { intent?: string }): Promise<PdfAnnotationRecord[]>;
};

type PdfAnnotationRecord = {
  subtype?: string;
  annotationType?: number;
  rect?: number[];
  url?: string;
  unsafeUrl?: string;
  dest?: unknown;
  action?: string;
  title?: string;
  contents?: string;
};

type SelectionToolbar = {
  text: string;
  page: number;
  x: number;
  y: number;
  rects: HighlightRect[];
};

type ToastMessage = {
  message: string;
  kind: "info" | "error";
};

type ReaderAssistantMode = "study" | "quotes";

type ReaderMarkupTool =
  | { kind: "none" }
  | { kind: "highlight"; color: string }
  | { kind: "erase" };

type ReferencePreviewKind =
  | "link"
  | "citation"
  | "equation"
  | "figure"
  | "table"
  | "section"
  | "page"
  | "algorithm"
  | "theorem"
  | "definition"
  | "remark";

type PdfLinkPreviewTarget = {
  id: string;
  sourcePage: number;
  title: string;
  kind: "internal" | "external";
  previewKind: ReferencePreviewKind;
  rect: { left: number; top: number; width: number; height: number };
  url?: string;
  dest?: unknown;
  targetPage?: number;
  targetText?: string;
  excerpt?: string;
  referenceText?: string;
};

type LinkPreviewState =
  | {
      kind: "internal";
      sourcePage: number;
      targetPage: number;
      title: string;
      imageDataUrl: string;
      previewMode: "page" | "region";
      previewKind: ReferencePreviewKind;
      targetText?: string;
      excerpt?: string;
      referenceText?: string;
    }
  | {
      kind: "external";
      sourcePage: number;
      title: string;
      url: string;
      summary: string;
    };

type SentenceUnit = {
  id: string;
  page: number;
  index: number;
  source: string;
};

type TranslationPair = {
  id?: string;
  sourceIds?: string[];
  source: string;
  translation: string;
};

type TranslationUnit = SentenceUnit & {
  translation: string;
  status: "pending" | "complete" | "missing";
  aiSegment?: boolean;
  sourceIds?: string[];
};

type TextLayerBox = {
  text: string;
  start: number;
  end: number;
  rect: { left: number; top: number; width: number; height: number };
  fontSize: number;
  fontName: string;
};

type TextLine = {
  text: string;
  rect: { left: number; top: number; width: number; height: number };
  fontSize: number;
  fontNames: string[];
  boxes: TextLayerBox[];
};

type OutlineRow = {
  id: string;
  page: number;
  title: string;
  level: number;
  source: "detected" | "ai" | "pdf" | "page" | "pending";
  anchorId?: string;
};

type OutlineAnchor = {
  id: string;
  page: number;
  title: string;
  level: number;
  top: number;
  left: number;
  width: number;
  height: number;
};

type AutoHighlightCandidate = {
  page: number;
  text: string;
  tag: string;
  reason: string;
};

type WordMeaningEntry = {
  id: string;
  word: string;
  meaning: string;
  documentId: string;
  documentTitle: string;
  context: string;
  createdAt: string;
  source: "ai" | "dictionary" | "local";
};

type WordMeaningMap = Record<string, WordMeaningEntry[]>;

type OnlineDictionaryCacheEntry = {
  meaning: string;
  source: string;
  fetchedAt: string;
  parserVersion?: string;
};

type OnlineDictionaryCache = Record<string, OnlineDictionaryCacheEntry>;

type ParsedWordMeaning = {
  word: string;
  meaning: string;
  context: string;
};

type DocumentTermCandidate = {
  term: string;
  kind: "word" | "phrase";
  count: number;
  score: number;
  contextNeeded: boolean;
  reason: string;
  examples: string[];
};

type WordPopup = {
  word: string;
  page: number;
  sourceSentenceId?: string;
  context: string;
  x: number;
  y: number;
  side: "left" | "right";
};

type AiDisplaySection = {
  id: string;
  titleKey: string;
  taskTypes: string[];
  emptyKey: string;
};

const explanationTag = "Explanation";
const explanationColor = "#d9e5ff";
const explanationTasks = new Set(["explainText", "explainRegionImage"]);
const chatPlanTaskType: AiTaskType = "chatWithPaperPlan";
const wordMeaningTaskType: AiTaskType = "defineWordMeanings";
const wordMeaningMapSettingKey = "wordMeaningMapJson";
const wordMeaningLookupEnabledSettingKey = "wordMeaningLookupEnabled";
const onlineDictionaryCacheSettingKey = "onlineDictionaryCacheJson";
const onlineDictionaryParserVersion = "ko-direct-v3";
const onlineDictionarySourceLabel = `Korean dictionary APIs ${onlineDictionaryParserVersion}`;
const documentWordListSettingPrefix = "documentWordList:";
const wordMeaningBatchLimit = 120;
const onlineDictionaryBatchLimit = 180;
const rightPanelHiddenTasks = new Set(["translatePage", chatPlanTaskType, wordMeaningTaskType]);

const aiDisplaySections: AiDisplaySection[] = [
  {
    id: "keywords",
    titleKey: "keywordsDict",
    taskTypes: [],
    emptyKey: "keywordsEmpty",
  },
  {
    id: "three",
    titleKey: "threeLineSummary",
    taskTypes: ["summarizePaper"],
    emptyKey: "threeLineEmpty",
  },
  {
    id: "summary",
    titleKey: "summary",
    taskTypes: ["summarizePaper"],
    emptyKey: "summaryEmpty",
  },
];

const taskLabelKeys: Record<string, string> = {
  explainText: "explain",
  explainRegionImage: "imageExplanation",
  translateText: "translate",
  translatePage: "autoTranslate",
  summarizePaper: "summary",
  chatWithPaper: "askAi",
  chatWithPaperPlan: "askAi",
  autoHighlight: "autoHighlightCompact",
  citationReason: "citationReason",
  externalLinkSummary: "linkSummary",
  outlineDocument: "documentOutline",
  recommendPapers: "paperRecommendations",
  defineWordMeanings: "wordMeanings",
};

const annotationFilters = [
  { id: "text", labelKey: "text", color: "#8f8f98" },
  { id: "image", labelKey: "image", color: "#ff9d00" },
  { id: "url", labelKey: "url", color: "#4d9fff" },
  { id: "table", labelKey: "table", color: "#b86428" },
  { id: "formula", labelKey: "formula", color: "#ff4b66" },
];

const highlightPalettes = [
  {
    name: "Paper Pilot Basic",
    colors: ["#f7c8d8", "#d9f2dd", "#d8edf1"],
    tags: ["Originality", "Method", "Result"],
  },
  {
    name: "Deep Spread",
    colors: ["#f0d5c7", "#cbe8df", "#d5e7f5"],
    tags: ["Background", "Evidence", "Limit"],
  },
  {
    name: "Point Stroke",
    colors: ["#f3c9c3", "#b4e3d5", "#c8d9df"],
    tags: ["Problem", "Solution", "Compare"],
  },
];


const initialState: AppStateRecord = {
  folders: [{ id: "root", parentId: null, name: "Library", createdAt: nowIso() }],
  documents: [],
  pages: [],
  annotations: [],
  comments: [],
  notes: [],
  aiResults: [],
  citationCards: [],
  recommendationRuns: [],
  settings: {
    language: "ko",
    uiLanguage: "ko",
    translationLanguage: "ko",
    theme: "light",
    fontScale: "1",
    mathDelimiter: "$$",
    autoTranslate: "true",
    autoTranslateAutostartMigrated: "true",
    autoHighlight: "false",
    aiProvider: "codex-cli",
    aiModel: "",
    codexModel: "",
    codexReasoningEffort: "",
    claudeModel: "",
    bridgePath: "bridge",
    customPrompt: "",
    readerOutlineWidth: "220",
    readerTranslationWidth: "360",
    readerRightPanelWidth: "340",
    wordMeaningLookupEnabled: "true",
    wordMeaningMapJson: "{}",
    onlineDictionaryCacheJson: "{}",
  },
};

type UiLanguage = "ko" | "en";

type UiStrings = Record<string, string>;

const uiStrings: Record<UiLanguage, UiStrings> = {
  ko: {
    add: "추가",
    library: "라이브러리",
    settings: "설정",
    openOutline: "목차 열기",
    closeOutline: "목차 닫기",
    resizeOutline: "목차 너비 조절",
    gridView: "그리드 보기",
    outlineView: "목차 보기",
    pageGrid: "페이지 그리드",
    documentInfo: "문서 정보",
    search: "검색",
    searchPrompt: "검색어를 입력하세요.",
    zoom: "확대/축소",
    zoomOut: "축소",
    zoomIn: "확대",
    page: "페이지",
    pages: "페이지",
    noDocument: "문서 없음",
    untitledPaper: "제목 없는 논문",
    aiOutline: "AI 목차",
    aiOutlinePending: "AI 목차 생성 중",
    autoHighlight: "자동 하이라이트",
    autoHighlightCompact: "오토하이라이트",
    autoHighlightToggle: "오토 하이라이트 켜기 끄기",
    autoHighlightCurrentPageOnly: "ON이어도 현재 페이지만 자동 하이라이트합니다.",
    autoHighlightCurrentPage: "현재 페이지 하이라이트",
    autoHighlightCurrentPageSetting: "현재 페이지만 자동 하이라이트",
    originality: "독창성",
    method: "방법",
    result: "결과",
    explainImage: "이미지 설명",
    imageExplanation: "이미지 설명",
    autoTranslate: "자동 번역",
    translatePage: "번역 실행",
    translationPanel: "번역창",
    openTranslationPanel: "번역창 열기",
    closeTranslationPanel: "번역창 닫기",
    shareTranslatedPdf: "번역 PDF 공유",
    addPdf: "PDF 추가",
    more: "더보기",
    panel: "패널",
    working: "작업 중",
    settingsTitle: "설정",
    settingsSubtitle: "UI 언어, 번역 언어, AI 에이전트, 화면 표시를 관리합니다.",
    uiLanguage: "UI 언어",
    translationLanguage: "번역 언어",
    theme: "테마",
    fontSize: "글자 크기",
    mathDelimiter: "수식 구분자",
    aiProvider: "AI 제공자",
    model: "모델",
    providerDefault: "제공자 기본값",
    bridgePath: "에이전트 큐 경로",
    customPrompt: "추가 프롬프트",
    runtimeHint: "AI 작업은 outbox/inbox JSON 큐로 처리되며, Codex CLI 또는 Claude Code가 로컬 작업을 수행합니다.",
    resetTitle: "라이브러리 전체 삭제",
    resetDescription: "가져온 PDF, 추출 텍스트, 하이라이트, 주석, 노트, AI 결과, 인용 카드, 에이전트 로그를 모두 삭제합니다.",
    resetAction: "라이브러리 전체 삭제",
    auto: "자동",
    refreshTranslation: "번역 새로고침",
    emptyTranslation: "PDF 텍스트를 읽는 중입니다. 문장이 추출되면 번역을 자동으로 요청합니다.",
    translationPending: "번역을 가져오는 중입니다...",
    translationMissing: "아직 번역이 없습니다. 새로고침을 누르면 이 문장 단위 번역을 요청합니다.",
    agentPending: "에이전트 응답 대기 중",
    keywordsDict: "키워드 사전",
    threeLineSummary: "3줄 요약",
    summary: "요약",
    keywordsEmpty: "AI 결과가 들어오면 핵심 키워드를 자동으로 정리합니다.",
    threeLineEmpty: "3줄 요약을 실행하면 여기에 정리됩니다.",
    summaryEmpty: "요약 또는 질문 답변 결과가 여기에 표시됩니다.",
    explain: "설명",
    translate: "번역",
    askAi: "AI에게 질문",
    citationReason: "인용 이유",
    linkSummary: "링크 요약",
    documentOutline: "문서 개요",
    paperRecommendations: "논문 추천",
    text: "텍스트",
    image: "이미지",
    url: "URL",
    table: "표",
    formula: "수식",
    activity: "활동",
    citations: "인용",
    notes: "주석",
    info: "정보",
    aiPendingAnswer: "에이전트 답변을 가져오는 중입니다.",
    noAnswerContent: "표시할 답변 내용이 없습니다.",
    pageTranslationFallback: "이 페이지의 텍스트를 렌더링한 뒤 자동 번역을 실행하면 번역 결과가 여기에 표시됩니다.",
    translationQueued: "번역 대기 중입니다.",
    translationMissingSaved: "아직 저장된 번역이 없습니다.",
    shareTruncated: "번역이 길어 일부 문장은 잘릴 수 있습니다.",
    noSentencesOnPage: "이 페이지에서 추출된 문장이 없습니다.",
    addPdfDrop: "클릭하거나 PDF를 이 화면으로 끌어오세요.",
    addPdfToSelectedFolder: "선택한 폴더에 논문을 추가합니다.",
    newFolder: "새 폴더",
    createFolder: "폴더 만들기",
    createUnderCurrentFolder: "현재 폴더 아래 만들기",
    createChildFolder: "하위 폴더 만들기",
    rename: "이름 수정",
    deleteFolder: "폴더 삭제",
    folders: "폴더",
    allDocuments: "전체 문서",
    allPapers: "전체 논문",
    libraryRoot: "라이브러리",
    librarySearchPlaceholder: "제목, 저자, 연도, 초록 검색",
    documentsSuffix: "개 문서",
    papersSuffix: "편",
    currentListSelect: "현재 목록 선택",
    selectedSuffix: "개 선택됨",
    moveSelectedPapersPlaceholder: "선택 논문 이동...",
    moveSelectedPapers: "선택 논문 이동",
    delete: "삭제",
    deletePaper: "논문 삭제",
    noPdfInView: "이 보기에는 PDF가 없습니다",
    noPaperInView: "이 보기에는 논문이 없습니다",
    addPdfOrChooseFolder: "PDF를 추가하거나 다른 폴더를 선택하세요.",
    open: "열기",
    bookmark: "북마크",
    removeBookmark: "북마크 해제",
    noAuthors: "저자 정보 없음",
    unknownYear: "연도 -",
    pageSuffix: "쪽",
    emptyReaderTitle: "PDF를 추가하거나 여세요",
    emptyReaderHint: "첫 화면에서 PDF를 추가하고 바로 읽기 작업을 시작할 수 있습니다.",
    openStoredPdf: "저장된 PDF 열기",
    selectedDocumentNeedsLoad: "문서가 선택되었습니다. 로컬 PDF 파일을 불러와 페이지를 렌더링하세요.",
    selectPdf: "PDF 선택",
    highlight: "하이라이트",
    comment: "주석",
    copy: "복사",
    resizeRightPanel: "오른쪽 패널 너비 조절",
    studyTools: "학습 도구",
    highlights: "하이라이트",
    citationCards: "인용카드",
    close: "닫기",
    openPdfForPanels: "PDF를 열면 작업 패널을 사용할 수 있습니다.",
    agentRun: "에이전트 실행",
    refreshResults: "결과 새로고침",
    imageRegion: "이미지 영역",
    suggestedQuestion: "추천 질문",
    suggestedQuestionText: "이 논문의 핵심 기여와 한계를 한국어로 정리해줘.",
    askAnything: "무엇이든 질문하세요.",
    send: "보내기",
    refresh: "새로고침",
    all: "전체",
    quoteSearch: "검색",
    quoteCardsEmpty: "선택 텍스트 설명, 이미지 설명, 인용 이유 결과가 인용카드처럼 쌓입니다.",
    aiResultsEmpty: "AI 에이전트 결과가 여기에 표시됩니다.",
    deleteExplanation: "설명 삭제",
    compactView: "작게 보기",
    fullScreen: "전체화면",
    linkPreview: "링크 미리보기",
    preview: "미리보기",
    sourcePage: "원문 페이지",
    preparingPreview: "미리보기를 준비하는 중입니다...",
    resetPosition: "위치 초기화",
    aiSummary: "AI 요약",
    goToLink: "링크로 이동",
    goToPage: "해당 페이지로 이동",
    externalLinkPreview: "외부 링크 미리보기",
    externalPreviewDescription: "바로 새 탭을 열기 전에 주소를 확인할 수 있도록 미리보기로 표시했습니다.",
    externalPreviewPath: "경로",
    externalPreviewConnectsTo: "로 연결되는 외부 링크입니다.",
    changeTo: "색상 변경",
    goToHighlight: "하이라이트로 이동",
    deleteAllHighlights: "전체 하이라이트 삭제",
    manualAiHighlightsEmpty: "수동/AI 하이라이트가 여기에 표시됩니다.",
    extractReferences: "참고문헌 추출",
    findLinks: "링크 찾기",
    untitledReference: "제목 없는 참고문헌",
    deleteCitation: "인용 삭제",
    openPaper: "논문 열기",
    citationReasonPlaceholder: "인용 이유",
    reason: "이유",
    extractReferencesEmpty: "참고문헌을 추출하면 인용 카드가 만들어집니다.",
    markdownNotes: "Markdown 주석",
    saving: "저장 중...",
    saveNote: "주석 저장",
    unsavedChanges: "저장되지 않은 변경",
    saved: "저장됨",
    saveFailed: "저장 실패",
    extractedTextPreview: "추출 텍스트 미리보기",
    renderPagesToExtract: "페이지를 렌더링하면 선택 가능한 텍스트가 추출됩니다.",
    title: "제목",
    authors: "저자",
    year: "연도",
    abstract: "초록",
    folder: "폴더",
    jsonExport: "JSON 내보내기",
    zipExport: "Zip 내보내기",
    outline: "목차",
    searchHits: "검색 결과",
    noActiveSearchHits: "활성 검색 결과가 없습니다.",
    installed: "설치됨",
    notInstalled: "미설치",
    unknown: "확인 불가",
    claudeMissingHelp: "Claude Code CLI를 설치하거나 CLAUDE_CODE_BIN/CLAUDE_BIN 경로를 설정하세요.",
    claudeMissingSuffix: " (미설치)",
    browserPreviewStatus: "브라우저 프리뷰에서는 CLI 설치 상태를 확인할 수 없습니다. 데스크톱 앱에서는 실제 CLI 경로를 확인합니다.",
    folderNamePrompt: "폴더 이름",
    childFolderNamePrompt: "새 폴더 이름",
    commentPrompt: "주석",
    cannotDeleteRootFolder: "라이브러리 최상위 폴더는 삭제할 수 없습니다.",
    noSavedExplanation: "아직 저장된 설명 답변이 없습니다. 에이전트 결과를 가져오면 다시 열 수 있습니다.",
    openSavedExplanation: "저장된 설명 열기",
    previewTargetNotFound: "미리보기할 링크 위치를 찾지 못했습니다.",
    referencePreviewNotFound: "이 참조의 정확한 미리보기 위치를 찾지 못했습니다.",
    invalidExternalUrl: "외부 링크 주소가 올바르지 않아 열지 않았습니다.",
    noteSaved: "노트를 저장했습니다.",
    noteDeleted: "노트를 삭제했습니다.",
    deleteNote: "노트 삭제",
    wordMeanings: "단어 뜻",
    buildWordMeanings: "단어 뜻 만들기",
    adjustWordMeaning: "뜻 수정",
    wordMeaningLookupOn: "단어 뜻 보기 켜짐",
    wordMeaningLookupOff: "단어 뜻 보기 꺼짐",
    wordMeaningLoading: "한국어 뜻을 불러오는 중...",
    wordMeaningNone: "저장된 한국어 뜻이 없습니다.",
    wordMeaningNoText: "추출된 단어가 없습니다.",
    wordMeaningNoMissing: "새로 만들 단어 뜻이 없습니다.",
    wordMeaningAdjustQueued: "단어 뜻 수정 요청을 대기열에 추가했습니다.",
    reasoningEffort: "추론 강도",
    openDocumentFirst: "먼저 문서를 여세요.",
    openPdfFirst: "먼저 PDF를 여세요.",
    renderPdfFirstForShare: "PDF를 먼저 열어 렌더링한 뒤 공유해 주세요.",
    pdfExportCancelled: "PDF 내보내기가 취소되었습니다.",
    translatedPdfSaved: "번역 PDF 파일을 저장했습니다.",
    translatedPdfDownloaded: "번역 PDF 파일을 다운로드했습니다.",
    copiedSuffix: "복사됨",
    libraryResetDone: "라이브러리와 작업공간 파일을 초기화했습니다.",
    dropPdfsOverlay: "PDF를 놓으면 라이브러리에 추가됩니다",
    dismissMessage: "메시지 닫기",
    regionSizeLabel: "영역",
    dragRegionPrompt: "그림, 표, 수식 영역을 드래그하세요.",
    dropOrChoosePdf: "PDF 파일을 끌어오거나 선택하세요.",
    regionSelectionCancelled: "영역 선택이 취소되었습니다.",
    imageExplanationButtonSaved: "이미지 설명 버튼을 선택한 영역 오른쪽에 저장했습니다.",
    explanationButtonSaved: "설명 버튼을 선택한 줄 오른쪽에 저장했습니다.",
    taskStartedPrefix: "에이전트 시작",
    taskQueuedSuffix: "대기열에 추가했습니다. 에이전트를 실행해 처리하세요.",
    taskCompletedPrefix: "완료",
    noPendingAgentTasks: "대기 중인 에이전트 작업이 없습니다.",
    agentInboxChecked: "에이전트 inbox를 확인했습니다.",
    noAgentWorkerStarted: "시작된 에이전트 작업자가 없습니다.",
    receivedAgentResultsSuffix: "개 에이전트 결과를 받았습니다.",
    highlightsAddedSuffix: "개 AI 하이라이트를 추가했습니다.",
    noExtractableTextCurrentPage: "현재 페이지에서 아직 추출 가능한 텍스트가 없습니다.",
    autoHighlightAlreadyQueued: "현재 페이지는 이미 자동 하이라이트 작업이 대기 중이거나 저장되어 있습니다.",
    queuedAutoHighlightCurrentPage: "현재 페이지 AI 하이라이트 작업을 대기열에 추가했습니다.",
    highlightedLocalCandidatesSuffix: "개 로컬 후보를 현재 페이지에 하이라이트했습니다.",
    citationCardsExtractedSuffix: "개 인용 카드를 추출했습니다.",
    noReferencesFoundYet: "아직 참고문헌을 찾지 못했습니다.",
    noCitationsForLinks: "링크를 찾을 인용 문헌이 없습니다.",
    citationLinksConnectedSuffix: "개 인용 논문 링크를 연결했습니다.",
    deletedExplanation: "설명을 삭제했습니다.",
    noHighlightsToDelete: "삭제할 하이라이트가 없습니다.",
    autoHighlightTurnedOff: "자동 하이라이트가 꺼졌습니다.",
    deleteAllHighlightsConfirm: "이 문서의 모든 하이라이트를 삭제할까요?",
    deletedHighlightsSuffix: "개 하이라이트를 삭제했습니다.",
    deleteFolderConfirm: "이 폴더와 하위 폴더를 삭제할까요? 포함된 논문은 다음 폴더로 이동됩니다:",
    deleteDocumentsConfirm: "선택한 논문을 라이브러리에서 삭제할까요?",
    zipExportWrittenPrefix: "Zip 내보내기 저장 위치",
    pdfSavedPrefix: "PDF 저장 위치",
    libraryResetConfirm: "라이브러리 전체를 삭제할까요?\n\n가져온 PDF, 추출 텍스트, 하이라이트, 주석, 노트, AI 결과, 인용 카드, 에이전트 대기/로그 파일을 삭제합니다. 원본 외부 파일은 건드리지 않습니다.",
    libraryResetSkippedPrefix: "라이브러리를 초기화했습니다. 앱 작업공간 밖이라 건너뛴 경로:",
    openPdfErrorPrefix: "PDF 열기 실패",
    importFailedPrefix: "가져오기 실패",
    aiTaskFailedPrefix: "AI 작업 실패",
    previewFailedPrefix: "미리보기 생성 실패",
    shareFileFailedPrefix: "파일 공유 실패",
    libraryResetFailedPrefix: "라이브러리 초기화 실패",
    citationLinkFailedPrefix: "인용 논문 링크 연결 실패",
    couldNotSavePageTextPrefix: "페이지 텍스트 저장 실패",
    couldNotDeleteAnnotationPrefix: "주석 삭제 실패",
    couldNotDeleteHighlightsPrefix: "전체 하이라이트 삭제 실패",
    couldNotDeleteExplanationPrefix: "설명 삭제 실패",
  },
  en: {
    add: "Add",
    library: "Library",
    settings: "Settings",
    openOutline: "Open outline",
    closeOutline: "Close outline",
    resizeOutline: "Resize outline",
    gridView: "Grid view",
    outlineView: "Outline view",
    pageGrid: "Page grid",
    documentInfo: "Document info",
    search: "Search",
    searchPrompt: "Enter a search term.",
    zoom: "Zoom",
    zoomOut: "Zoom out",
    zoomIn: "Zoom in",
    page: "Page",
    pages: "pages",
    noDocument: "No document",
    untitledPaper: "Untitled paper",
    aiOutline: "AI outline",
    aiOutlinePending: "AI outline pending",
    autoHighlight: "Auto highlight",
    autoHighlightCompact: "Auto highlight",
    autoHighlightToggle: "Toggle auto highlight",
    autoHighlightCurrentPageOnly: "Even when ON, auto highlight runs only on the current page.",
    autoHighlightCurrentPage: "Highlight current page",
    autoHighlightCurrentPageSetting: "Auto highlight current page only",
    originality: "Originality",
    method: "Methods",
    result: "Results",
    explainImage: "Explain image",
    imageExplanation: "Image explanation",
    autoTranslate: "Auto translate",
    translatePage: "Translate page",
    translationPanel: "Translation",
    openTranslationPanel: "Open translation panel",
    closeTranslationPanel: "Close translation panel",
    shareTranslatedPdf: "Share translated PDF",
    addPdf: "Add PDF",
    more: "More",
    panel: "Panel",
    working: "Working",
    settingsTitle: "Settings",
    settingsSubtitle: "Manage UI language, translation language, AI agents, and display preferences.",
    uiLanguage: "UI language",
    translationLanguage: "Translation language",
    theme: "Theme",
    fontSize: "Font size",
    mathDelimiter: "Math delimiter",
    aiProvider: "AI provider",
    model: "Model",
    providerDefault: "Provider default",
    bridgePath: "Agent queue path",
    customPrompt: "Additional prompt",
    runtimeHint: "AI tasks are handled through outbox/inbox JSON queues, with Codex CLI or Claude Code doing the local work.",
    resetTitle: "Delete entire library",
    resetDescription: "Delete imported PDFs, extracted text, highlights, comments, notes, AI results, citation cards, and agent logs.",
    resetAction: "Delete entire library",
    auto: "Auto",
    refreshTranslation: "Refresh translation",
    emptyTranslation: "Reading PDF text. Translation will be requested automatically once sentences are extracted.",
    translationPending: "Fetching translation...",
    translationMissing: "No translation yet. Press refresh to request sentence-level translation.",
    agentPending: "Waiting for agent response",
    keywordsDict: "Keyword dictionary",
    threeLineSummary: "3-line summary",
    summary: "Summary",
    keywordsEmpty: "When AI results arrive, key terms will be organized here automatically.",
    threeLineEmpty: "Run a 3-line summary and it will appear here.",
    summaryEmpty: "Summaries and question answers will appear here.",
    explain: "Explain",
    translate: "Translate",
    askAi: "Ask AI",
    citationReason: "Citation reason",
    linkSummary: "Link summary",
    documentOutline: "Document outline",
    paperRecommendations: "Paper recommendations",
    text: "Text",
    image: "Image",
    url: "URL",
    table: "Table",
    formula: "Formula",
    activity: "Activity",
    citations: "Citations",
    notes: "Notes",
    info: "Info",
    aiPendingAnswer: "Fetching the agent answer.",
    noAnswerContent: "No answer content to display.",
    pageTranslationFallback: "Render this page's text and run auto translation to show the translation here.",
    translationQueued: "Translation pending.",
    translationMissingSaved: "No saved translation yet.",
    shareTruncated: "Some sentences may be clipped because the translation is long.",
    noSentencesOnPage: "No extracted sentences on this page.",
    addPdfDrop: "Click or drag PDFs onto this screen.",
    addPdfToSelectedFolder: "Add papers to the selected folder.",
    newFolder: "New folder",
    createFolder: "Create folder",
    createUnderCurrentFolder: "Create under current folder",
    createChildFolder: "Create child folder",
    rename: "Rename",
    deleteFolder: "Delete folder",
    folders: "Folders",
    allDocuments: "All documents",
    allPapers: "All papers",
    libraryRoot: "Library",
    librarySearchPlaceholder: "Search title, author, year, abstract",
    documentsSuffix: "documents",
    papersSuffix: "papers",
    currentListSelect: "Select current list",
    selectedSuffix: "selected",
    moveSelectedPapersPlaceholder: "Move selected papers...",
    moveSelectedPapers: "Move selected papers",
    delete: "Delete",
    deletePaper: "Delete paper",
    noPdfInView: "No PDFs in this view",
    noPaperInView: "No papers in this view",
    addPdfOrChooseFolder: "Add a PDF or choose another folder.",
    open: "Open",
    bookmark: "Bookmark",
    removeBookmark: "Remove bookmark",
    noAuthors: "No author information",
    unknownYear: "Year -",
    pageSuffix: "p.",
    emptyReaderTitle: "Add or open a PDF",
    emptyReaderHint: "Add a PDF from the first screen and start reading right away.",
    openStoredPdf: "Open stored PDF",
    selectedDocumentNeedsLoad: "The document is selected. Load its local PDF file to render pages.",
    selectPdf: "Select PDF",
    highlight: "Highlight",
    comment: "Comment",
    copy: "Copy",
    resizeRightPanel: "Resize right panel",
    studyTools: "Study tools",
    highlights: "Highlights",
    citationCards: "Citation cards",
    close: "Close",
    openPdfForPanels: "Open a PDF to use the working panels.",
    agentRun: "Run agent",
    refreshResults: "Refresh results",
    imageRegion: "Image region",
    suggestedQuestion: "Suggested question",
    suggestedQuestionText: "Summarize this paper's key contributions and limitations in English.",
    askAnything: "Ask anything.",
    send: "Send",
    refresh: "Refresh",
    all: "All",
    quoteSearch: "Search",
    quoteCardsEmpty: "Text explanations, image explanations, and citation reasons will stack here as quote cards.",
    aiResultsEmpty: "AI agent results will appear here.",
    deleteExplanation: "Delete explanation",
    compactView: "Compact view",
    fullScreen: "Full screen",
    linkPreview: "Link preview",
    preview: "Preview",
    sourcePage: "Source page",
    preparingPreview: "Preparing preview...",
    resetPosition: "Reset position",
    aiSummary: "AI summary",
    goToLink: "Go to link",
    goToPage: "Go to page",
    externalLinkPreview: "External link preview",
    externalPreviewDescription: "Previewing this address before opening it in a new tab.",
    externalPreviewPath: "Path",
    externalPreviewConnectsTo: "is an external link.",
    changeTo: "Change to",
    goToHighlight: "Go to highlight",
    deleteAllHighlights: "Delete all highlights",
    manualAiHighlightsEmpty: "Manual and AI highlights appear here.",
    extractReferences: "Extract references",
    findLinks: "Find links",
    untitledReference: "Untitled reference",
    deleteCitation: "Delete citation",
    openPaper: "Open paper",
    citationReasonPlaceholder: "Citation reason",
    reason: "Reason",
    extractReferencesEmpty: "Extract references to create citation cards.",
    markdownNotes: "Markdown notes",
    saving: "Saving...",
    saveNote: "Save note",
    unsavedChanges: "Unsaved changes",
    saved: "Saved",
    saveFailed: "Save failed",
    extractedTextPreview: "Extracted text preview",
    renderPagesToExtract: "Render pages to extract selectable text.",
    title: "Title",
    authors: "Authors",
    year: "Year",
    abstract: "Abstract",
    folder: "Folder",
    jsonExport: "JSON export",
    zipExport: "Zip export",
    outline: "Outline",
    searchHits: "Search hits",
    noActiveSearchHits: "No active search hits.",
    installed: "Installed",
    notInstalled: "Not installed",
    unknown: "Unknown",
    claudeMissingHelp: "Install Claude Code CLI or set CLAUDE_CODE_BIN/CLAUDE_BIN.",
    claudeMissingSuffix: " (not installed)",
    browserPreviewStatus: "CLI install status cannot be checked in browser preview. The desktop app checks the actual CLI path.",
    folderNamePrompt: "Folder name",
    childFolderNamePrompt: "New folder name",
    commentPrompt: "Comment",
    cannotDeleteRootFolder: "The library root folder cannot be deleted.",
    noSavedExplanation: "No saved explanation yet. Fetch agent results and try again.",
    openSavedExplanation: "Open saved explanation",
    previewTargetNotFound: "Could not find the link location to preview.",
    referencePreviewNotFound: "Could not find the exact preview location for this reference.",
    invalidExternalUrl: "The external link address is invalid and was not opened.",
    noteSaved: "Note saved.",
    noteDeleted: "Note deleted.",
    deleteNote: "Delete note",
    wordMeanings: "Word meanings",
    buildWordMeanings: "Build word meanings",
    adjustWordMeaning: "Adjust meaning",
    wordMeaningLookupOn: "Word meaning popup on",
    wordMeaningLookupOff: "Word meaning popup off",
    wordMeaningLoading: "Loading Korean meaning...",
    wordMeaningNone: "No saved Korean meaning.",
    wordMeaningNoText: "No extracted words yet.",
    wordMeaningNoMissing: "No missing word meanings.",
    wordMeaningAdjustQueued: "Queued word meaning adjustment.",
    reasoningEffort: "Reasoning effort",
    openDocumentFirst: "Open a document first.",
    openPdfFirst: "Open a PDF first.",
    renderPdfFirstForShare: "Open and render the PDF before sharing.",
    pdfExportCancelled: "PDF export cancelled.",
    translatedPdfSaved: "Translated PDF file saved.",
    translatedPdfDownloaded: "Translated PDF file downloaded.",
    copiedSuffix: "copied",
    libraryResetDone: "Library and workspace files were reset.",
    dropPdfsOverlay: "Drop PDFs to add them to the library",
    dismissMessage: "Dismiss message",
    regionSizeLabel: "Region",
    dragRegionPrompt: "Drag over a figure, table, or formula region.",
    dropOrChoosePdf: "Drop or choose a PDF file.",
    regionSelectionCancelled: "Region selection cancelled.",
    imageExplanationButtonSaved: "Saved the image explanation button beside the selected region.",
    explanationButtonSaved: "Saved the explanation button beside the selected line.",
    taskStartedPrefix: "Started agent for",
    taskQueuedSuffix: "queued. Run the agent to process it.",
    taskCompletedPrefix: "Completed",
    noPendingAgentTasks: "No pending agent tasks.",
    agentInboxChecked: "Agent inbox checked.",
    noAgentWorkerStarted: "No agent worker started.",
    receivedAgentResultsSuffix: "agent result(s) received.",
    highlightsAddedSuffix: "AI highlight(s) added.",
    noExtractableTextCurrentPage: "No extractable text is available on the current page yet.",
    autoHighlightAlreadyQueued: "Current page already has auto-highlight work queued or saved.",
    queuedAutoHighlightCurrentPage: "Queued AI highlighting for the current page.",
    highlightedLocalCandidatesSuffix: "local candidate(s) highlighted on the current page.",
    citationCardsExtractedSuffix: "citation card(s) extracted.",
    noReferencesFoundYet: "No references found yet.",
    noCitationsForLinks: "No citation references available for link lookup.",
    citationLinksConnectedSuffix: "citation link(s) connected.",
    deletedExplanation: "Deleted explanation.",
    noHighlightsToDelete: "No highlights to delete.",
    autoHighlightTurnedOff: "Auto highlight is off.",
    deleteAllHighlightsConfirm: "Delete all highlights in this document?",
    deletedHighlightsSuffix: "highlight(s) deleted.",
    deleteFolderConfirm: "Delete this folder and its child folders? Included papers will be moved to:",
    deleteDocumentsConfirm: "Delete the selected papers from the library?",
    zipExportWrittenPrefix: "Zip export written to",
    pdfSavedPrefix: "PDF saved to",
    libraryResetConfirm: "Delete the entire library?\n\nThis deletes imported PDFs, extracted text, highlights, comments, notes, AI results, citation cards, and queued/logged agent files. Original external files are not touched.",
    libraryResetSkippedPrefix: "Library reset completed. Skipped paths outside the app workspace:",
    openPdfErrorPrefix: "Could not open PDF",
    importFailedPrefix: "Import failed",
    aiTaskFailedPrefix: "AI task failed",
    previewFailedPrefix: "Preview failed",
    shareFileFailedPrefix: "Share file failed",
    libraryResetFailedPrefix: "Library reset failed",
    citationLinkFailedPrefix: "Citation link failed",
    couldNotSavePageTextPrefix: "Could not save page text",
    couldNotDeleteAnnotationPrefix: "Could not delete annotation",
    couldNotDeleteHighlightsPrefix: "Could not delete all highlights",
    couldNotDeleteExplanationPrefix: "Could not delete explanation",
  },
};

const UiStringsContext = createContext<UiStrings>(uiStrings.ko);

function useUiStrings() {
  return useContext(UiStringsContext);
}

const translationLanguageOptions = [
  { value: "ko", ko: "한국어", en: "Korean", prompt: "Korean" },
  { value: "en", ko: "영어", en: "English", prompt: "English" },
  { value: "ja", ko: "일본어", en: "Japanese", prompt: "Japanese" },
  { value: "zh-Hans", ko: "중국어 간체", en: "Chinese (Simplified)", prompt: "Simplified Chinese" },
  { value: "zh-Hant", ko: "중국어 번체", en: "Chinese (Traditional)", prompt: "Traditional Chinese" },
  { value: "ru", ko: "러시아어", en: "Russian", prompt: "Russian" },
  { value: "es", ko: "스페인어", en: "Spanish", prompt: "Spanish" },
  { value: "fr", ko: "프랑스어", en: "French", prompt: "French" },
  { value: "de", ko: "독일어", en: "German", prompt: "German" },
  { value: "pt", ko: "포르투갈어", en: "Portuguese", prompt: "Portuguese" },
  { value: "vi", ko: "베트남어", en: "Vietnamese", prompt: "Vietnamese" },
  { value: "th", ko: "태국어", en: "Thai", prompt: "Thai" },
  { value: "id", ko: "인도네시아어", en: "Indonesian", prompt: "Indonesian" },
  { value: "ar", ko: "아랍어", en: "Arabic", prompt: "Arabic" },
];

function uiLanguageFromSettings(settings: Record<string, string>): UiLanguage {
  return settings.uiLanguage === "en" ? "en" : "ko";
}

function translationLanguageOption(value: string | undefined) {
  return translationLanguageOptions.find((option) => option.value === value) ?? translationLanguageOptions[0];
}

function translationLanguageNameFromSettings(settings: Record<string, string>) {
  return translationLanguageOption(settings.translationLanguage).prompt;
}

function translationLanguageLabel(value: string | undefined, uiLanguage: UiLanguage) {
  const option = translationLanguageOption(value);
  return uiLanguage === "ko" ? option.ko : option.en;
}

const providerModelSettingKeys: Record<AiProviderKind, string> = {
  "codex-cli": "codexModel",
  "claude-code": "claudeModel",
  "local-draft": "aiModel",
};

const providerModelOptions: Record<AiProviderKind, Array<{ value: string; label: string }>> = {
  "codex-cli": [
    { value: "gpt-5.5", label: "GPT-5.5 - latest frontier" },
    { value: "gpt-5.5-pro", label: "GPT-5.5 pro - highest precision" },
    { value: "gpt-5.4", label: "GPT-5.4 - coding/pro work" },
    { value: "gpt-5.4-pro", label: "GPT-5.4 pro" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 mini - faster/lower cost" },
    { value: "gpt-5.4-nano", label: "GPT-5.4 nano - cheapest GPT-5.4 class" },
    { value: "gpt-5.2-codex", label: "GPT-5.2-Codex - agentic coding" },
    { value: "gpt-5.1-codex", label: "GPT-5.1-Codex - agentic coding" },
    { value: "gpt-5.2", label: "GPT-5.2 - previous frontier" },
    { value: "gpt-5.1", label: "GPT-5.1 - previous coding model" },
    { value: "gpt-5", label: "GPT-5" },
    { value: "gpt-5-mini", label: "GPT-5 mini" },
    { value: "gpt-5-nano", label: "GPT-5 nano" },
    { value: "gpt-4.1", label: "GPT-4.1 - non-reasoning" },
  ],
  "claude-code": [
    { value: "sonnet", label: "Claude Sonnet" },
    { value: "opus", label: "Claude Opus" },
    { value: "haiku", label: "Claude Haiku" },
    { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
    { value: "claude-opus-4-20250514", label: "Claude Opus 4" },
    { value: "claude-3-5-haiku-20241022", label: "Claude 3.5 Haiku" },
  ],
  "local-draft": [],
};

const codexReasoningEffortOptions = [
  { value: "", label: "CLI default" },
  { value: "none", label: "none" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
];

function providerDisplayName(provider: string | null | undefined) {
  switch (normalizeAiProviderKind(provider)) {
    case "claude-code":
      return "Claude Code";
    case "local-draft":
      return "Local draft";
    case "codex-cli":
    default:
      return "Codex CLI";
  }
}

function providerModelSettingKey(provider: string | null | undefined) {
  return providerModelSettingKeys[normalizeAiProviderKind(provider)];
}

function aiModelForProvider(settings: Record<string, string>, provider: string | null | undefined) {
  const kind = normalizeAiProviderKind(provider);
  if (kind === "local-draft") {
    return "";
  }
  return settings[providerModelSettingKeys[kind]] || (kind === normalizeAiProviderKind(settings.aiProvider) ? settings.aiModel || "" : "");
}

function selectedAiModel(settings: Record<string, string>) {
  return aiModelForProvider(settings, settings.aiProvider);
}

function selectedCodexReasoningEffort(settings: Record<string, string>) {
  const value = (settings.codexReasoningEffort || "").trim().toLowerCase();
  return codexReasoningEffortOptions.some((option) => option.value === value) ? value : "";
}

function aiRuntimeLabel(settings: Record<string, string>, ui: UiStrings) {
  const model = selectedAiModel(settings) || ui.providerDefault;
  const effort = normalizeAiProviderKind(settings.aiProvider) === "codex-cli" ? selectedCodexReasoningEffort(settings) : "";
  return effort ? `${providerDisplayName(settings.aiProvider)} / ${model} / ${effort}` : `${providerDisplayName(settings.aiProvider)} / ${model}`;
}

function wordMeaningLookupEnabled(settings: Record<string, string>) {
  return settings[wordMeaningLookupEnabledSettingKey] !== "false";
}

const panelTabs: Array<{ id: PanelTab; label: string; icon: typeof Bot }> = [
  { id: "ai", label: "AI", icon: Bot },
  { id: "activity", label: "Activity", icon: ClipboardList },
  { id: "citations", label: "Citations", icon: Link },
  { id: "notes", label: "Notes", icon: MessageSquareText },
];

const defaultReaderZoom = 1.05;
const minReaderZoom = 0.55;
const maxReaderZoom = 2.5;
const stalePendingTranslationMs = 20 * 60 * 1000;
const nextPageTranslationReadProgress = 0.82;
const shortAskFullTextLimit = 80000;
const selectedAskPageTextLimit = 45000;
const selectedAskPageMaxCount = 12;
const selectedAskNeighborRadius = 1;
const layoutDefaults = {
  outline: 220,
  translation: 360,
  rightPanel: 340,
};
const layoutBounds = {
  outline: { min: 160, max: 420, setting: "readerOutlineWidth" },
  translation: { min: 280, max: 680, setting: "readerTranslationWidth" },
  rightPanel: { min: 280, max: 620, setting: "readerRightPanelWidth" },
};

type LayoutPane = keyof typeof layoutDefaults;

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function settingsNumber(settings: Record<string, string>, key: string, fallback: number, min: number, max: number) {
  const value = Number(settings[key]);
  return Number.isFinite(value) ? clampNumber(value, min, max) : fallback;
}

function documentZoomSettingKey(documentId: string) {
  return `documentZoom:${documentId}`;
}

function documentHorizontalScrollSettingKey(documentId: string) {
  return `documentScrollLeft:${documentId}`;
}

function zoomFromSettings(settings: Record<string, string>, documentId: string | null) {
  if (!documentId) {
    return defaultReaderZoom;
  }
  return settingsNumber(settings, documentZoomSettingKey(documentId), defaultReaderZoom, minReaderZoom, maxReaderZoom);
}

function horizontalScrollFromSettings(settings: Record<string, string>, documentId: string | null) {
  if (!documentId) {
    return 0;
  }
  const value = Number(settings[documentHorizontalScrollSettingKey(documentId)]);
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function downloadText(fileName: string, text: string, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function downloadBytes(fileName: string, bytes: Uint8Array, type: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function canvasToCompressedImageDataUrl(source: HTMLCanvasElement, maxSide = 1400) {
  const scale = Math.min(1, maxSide / Math.max(1, source.width, source.height));
  const target = document.createElement("canvas");
  target.width = Math.max(1, Math.round(source.width * scale));
  target.height = Math.max(1, Math.round(source.height * scale));
  const context = target.getContext("2d");
  if (!context) {
    return source.toDataURL("image/png");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, target.width, target.height);
  context.drawImage(source, 0, 0, target.width, target.height);
  return target.toDataURL("image/jpeg", 0.84);
}

type BrowserFileHandle = {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

async function saveBytesWithBrowserPicker(fileName: string, bytes: Uint8Array, type: string) {
  const picker = (window as Window & {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<BrowserFileHandle>;
  }).showSaveFilePicker;
  if (!picker) {
    return "unsupported" as const;
  }
  try {
    const handle = await picker({
      suggestedName: fileName,
      types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([new Uint8Array(bytes)], { type }));
    await writable.close();
    return "saved" as const;
  } catch (error) {
    if ((error as DOMException).name === "AbortError") {
      return "cancelled" as const;
    }
    throw error;
  }
}

function safeFileName(value: string, fallback = "paper-pilot-share") {
  const safe = (value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return safe || fallback;
}

function cleanSelection(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function compactUiText(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 3).trim()}...` : normalized;
}

function documentPages(state: AppStateRecord, documentId: string) {
  return state.pages
    .filter((page) => page.documentId === documentId)
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

function currentNote(state: AppStateRecord, documentId: string): NoteRecord {
  return (
    state.notes.find((note) => note.documentId === documentId) ?? {
      id: `note-${documentId}`,
      documentId,
      markdown: "",
      updatedAt: nowIso(),
    }
  );
}

function inferYear(value = ""): string {
  const match = value.match(/(19|20)\d{2}/);
  return match?.[0] ?? "";
}

function taskTitle(taskType: string, ui: UiStrings = uiStrings.ko) {
  const key = taskLabelKeys[taskType];
  return key ? ui[key] ?? taskType : taskType;
}

function formatResultTime(value: string) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("ko-KR", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function repairLegacyAiOutput(value: string) {
  return value;
}

function cleanAiOutput(value: string, status = "") {
  const text = repairLegacyAiOutput(value)
    .replace(/(?:[A-Za-z]+ bridge task|Agent task):[^\n]+/gi, "")
    .replace(/Status: local draft is ready[^\n]*/gi, "")
    .replace(/Status: waiting for[^\n]*/gi, "")
    .replace(/(?:Bridge|Agent) worker not started automatically:[\s\S]*/gi, "")
    .trim();
  if (status === "pending") {
    return text
      .split("\n")
      .filter((line) => !line.toLowerCase().includes("queued") && !line.toLowerCase().includes("agent"))
      .join("\n")
      .trim();
  }
  return text;
}

function getReadableAiOutput(result: AiResultRecord, ui: UiStrings = uiStrings.ko) {
  const text = cleanAiOutput(result.outputText, result.status);
  if (result.taskType.toString().startsWith("translate") && result.status !== "pending") {
    const translations = parseTranslationLines(text, 0);
    if (translations.length) {
      return translations.join("\n");
    }
  }
  if (result.status === "pending") {
    return text || ui.aiPendingAnswer;
  }
  return text || ui.noAnswerContent;
}

function latestResult(results: AiResultRecord[], taskTypes: string[]) {
  return results.find((result) => taskTypes.includes(result.taskType.toString()) && result.status !== "pending");
}

function resultSummaryMode(result: AiResultRecord) {
  return result.inputText.match(/^\[summary:\s*([^,\]]+)/i)?.[1] ?? "";
}

function latestInsightResult(results: AiResultRecord[], section: AiDisplaySection) {
  if (section.id === "keywords") {
    return undefined;
  }
  if (section.id === "three") {
    return results.find(
      (result) =>
        result.taskType.toString() === "summarizePaper" &&
        result.status !== "pending" &&
        resultSummaryMode(result) === "three-line",
    );
  }
  if (section.id === "summary") {
    return results.find(
      (result) =>
        result.taskType.toString() === "summarizePaper" &&
        result.status !== "pending" &&
        resultSummaryMode(result) !== "three-line",
    );
  }
  return latestResult(results, section.taskTypes);
}

function limitInsightText(sectionId: string, text: string) {
  const clean = text.trim();
  if (!clean || sectionId === "keywords") {
    return "";
  }
  const lines = clean
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (sectionId === "three") {
    const sourceLines = lines.length >= 2 ? lines : smartSentenceParts(clean);
    return sourceLines
      .slice(0, 3)
      .map((line) => line.replace(/^[-*\s]+/, "").replace(/^\d+[.)]\s*/, "").trim())
      .filter(Boolean)
      .map((line) => `- ${compactUiText(line, 72)}`)
      .join("\n");
  }
  if (sectionId === "summary") {
    return compactUiText(lines.slice(0, 5).join("\n"), 760);
  }
  return clean;
}

function resultPreviewText(result: AiResultRecord, ui: UiStrings = uiStrings.ko) {
  const text = getReadableAiOutput(result, ui);
  if (result.taskType.toString() === "summarizePaper") {
    return limitInsightText(resultSummaryMode(result) === "three-line" ? "three" : "summary", text);
  }
  if (result.taskType.toString() === "outlineDocument") {
    return compactUiText(
      text
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 10)
        .join("\n"),
      700,
    );
  }
  return text;
}

function latestProviderSessionId(results: AiResultRecord[], provider: string) {
  return (
    results.find(
      (result) =>
        result.status !== "failed" &&
        normalizeAiProviderKind(result.provider ?? provider) === provider &&
        typeof result.providerSessionId === "string" &&
        result.providerSessionId.length > 0,
    )?.providerSessionId ?? ""
  );
}

function keywordChipsFromText(text: string, limit = 10) {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "are",
    "was",
    "were",
    "can",
    "has",
    "have",
    "using",
    "paper",
    "model",
    "models",
    "language",
    "reasoning",
  ]);
  const counts = new Map<string, number>();
  for (const word of text.match(/[A-Za-z][A-Za-z-]{3,}/g) ?? []) {
    const key = word.toLowerCase();
    if (stop.has(key)) {
      continue;
    }
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function pageTextPreview(page: PageRecord | undefined, ui: UiStrings = uiStrings.ko) {
  if (!page?.text) {
    return ui.pageTranslationFallback;
  }
  return smartSentenceParts(page.text)
    .slice(0, 10)
    .join(" ")
    .trim();
}

function outlinePagesForAi(pages: PageRecord[], pageCount: number) {
  void pageCount;
  return pages
    .filter((page) => page.text.trim().length >= 20)
    .slice()
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

function tailUiText(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `...${normalized.slice(Math.max(0, normalized.length - limit + 3)).trim()}`;
}

function outlineTitleForPage(rows: OutlineRow[], pageNumber: number) {
  return rows
    .filter((row) => row.source !== "pending" && row.page === pageNumber)
    .slice(0, 3)
    .map((row) => row.title)
    .join(" / ");
}

function buildDocumentContextPack(
  document: DocumentRecord,
  pages: PageRecord[],
  outlineRows: OutlineRow[],
): DocumentContextPack {
  const sortedPages = pages.slice().sort((a, b) => a.pageNumber - b.pageNumber);
  const pageCount = Math.max(document.pageCount || 0, sortedPages.at(-1)?.pageNumber ?? 0, sortedPages.length);
  const extractedPages = sortedPages.filter((page) => page.text.trim().length > 0);
  return {
    documentId: document.id,
    title: document.title,
    pageCount,
    extractedPageCount: extractedPages.length,
    totalTextChars: extractedPages.reduce((sum, page) => sum + page.text.length, 0),
    outline: outlineRows
      .filter((row) => row.source !== "pending")
      .slice(0, 140)
      .map((row) => ({
        pageNumber: row.page,
        title: compactUiText(row.title, 180),
        level: row.level,
        source: row.source,
      })),
    pages: sortedPages.map((page) => {
      const title = outlineTitleForPage(outlineRows, page.pageNumber);
      return {
        pageNumber: page.pageNumber,
        outlineLabel: compactUiText(page.outlineLabel || "", 160),
        detectedTitle: compactUiText(title || page.outlineLabel || "", 180),
        charCount: page.text.length,
        start: compactUiText(page.text, 240),
        end: tailUiText(page.text, 220),
        hasText: page.text.trim().length > 0,
      };
    }),
  };
}

function selectedPageTextsFromPages(
  pages: PageRecord[],
  maxChars = selectedAskPageTextLimit,
  maxPages = selectedAskPageMaxCount,
): SelectedPageText[] {
  const rows: SelectedPageText[] = [];
  let usedChars = 0;
  for (const page of pages.slice().sort((a, b) => a.pageNumber - b.pageNumber)) {
    if (rows.length >= maxPages) {
      break;
    }
    const text = page.text.trim();
    if (!text) {
      continue;
    }
    const remaining = maxChars - usedChars;
    if (remaining <= 0) {
      break;
    }
    const selectedText = text.length > remaining ? `${text.slice(0, Math.max(0, remaining - 3)).trim()}...` : text;
    if (!selectedText) {
      break;
    }
    rows.push({
      pageNumber: page.pageNumber,
      text: selectedText,
      charCount: text.length,
    });
    usedChars += selectedText.length;
  }
  return rows;
}

function normalizeSelectedPages(values: unknown[], pageCount: number): number[] {
  const selected = new Set<number>();
  for (const value of values) {
    const pageNumber =
      typeof value === "number"
        ? Math.round(value)
        : typeof value === "string"
          ? Number(value.match(/\d+/)?.[0] ?? NaN)
          : Number(value);
    if (Number.isFinite(pageNumber) && pageNumber >= 1 && pageNumber <= pageCount) {
      selected.add(pageNumber);
    }
  }
  return [...selected];
}

function parseAiRetrievalPlan(outputText: string, pageCount: number): AiRetrievalPlan | null {
  const cleaned = stripJsonFence(cleanAiOutput(outputText));
  const candidates = [cleaned];
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch && objectMatch[0] !== cleaned) {
    candidates.push(objectMatch[0]);
  }
  for (const candidate of candidates) {
    try {
      const parsed = parseAiJson(candidate);
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      const record = parsed as Record<string, unknown>;
      const rawPages = Array.isArray(record.selectedPages)
        ? record.selectedPages
        : typeof record.selectedPages === "string"
          ? record.selectedPages.split(/[,\s]+/)
          : [];
      const selectedPages = normalizeSelectedPages(rawPages, pageCount).slice(0, 8);
      if (selectedPages.length === 0) {
        continue;
      }
      const confidence =
        record.confidence === "high" || record.confidence === "medium" || record.confidence === "low"
          ? record.confidence
          : "low";
      return {
        selectedPages,
        reason: typeof record.reason === "string" ? compactUiText(record.reason, 900) : "",
        confidence,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function fallbackRetrievalPlan(question: string, pages: PageRecord[], pageCount: number): AiRetrievalPlan {
  const context = buildRagContext(question, pages, {
    topK: 12,
    maxChars: 12000,
    maxChunksPerPage: 3,
  });
  const selectedPages = [...new Set(context.hits.map((hit) => hit.pageNumber))].slice(0, 8);
  if (selectedPages.length > 0) {
    return {
      selectedPages,
      reason: "AI retrieval planner output could not be parsed, so local lexical candidate pages were used as a fallback.",
      confidence: context.hasStrongMatch ? "medium" : "low",
    };
  }
  const extracted = pages.filter((page) => page.text.trim().length > 0).map((page) => page.pageNumber);
  const fallbackPages = normalizeSelectedPages(
    [...extracted.slice(0, 2), ...extracted.slice(-4), Math.max(1, pageCount - 1), pageCount],
    pageCount,
  ).slice(0, 8);
  return {
    selectedPages: fallbackPages.length ? fallbackPages : [1],
    reason: "AI retrieval planner output could not be parsed and local lexical search had no hits, so broad document pages were selected.",
    confidence: "low",
  };
}

function selectedPageTextsForPlan(
  pages: PageRecord[],
  plan: AiRetrievalPlan,
  pageCount: number,
): SelectedPageText[] {
  const expanded: number[] = [];
  const seen = new Set<number>();
  for (const page of plan.selectedPages) {
    for (let offset = -selectedAskNeighborRadius; offset <= selectedAskNeighborRadius; offset += 1) {
      const candidate = page + offset;
      if (candidate >= 1 && candidate <= pageCount && !seen.has(candidate)) {
        seen.add(candidate);
        expanded.push(candidate);
      }
    }
  }
  const wanted = expanded.slice(0, selectedAskPageMaxCount);
  const pageMap = new Map(pages.map((page) => [page.pageNumber, page]));
  return selectedPageTextsFromPages(
    wanted
      .map((pageNumber) => pageMap.get(pageNumber))
      .filter((page): page is PageRecord => Boolean(page))
      .sort((a, b) => a.pageNumber - b.pageNumber),
    selectedAskPageTextLimit,
    selectedAskPageMaxCount,
  );
}

function sentenceParts(text: string): string[] {
  return (text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 1);
}


const nonTerminalPeriodWords = new Set([
  "al",
  "approx",
  "cf",
  "col",
  "dr",
  "eq",
  "eqs",
  "fig",
  "figs",
  "inc",
  "jr",
  "mr",
  "mrs",
  "ms",
  "no",
  "nos",
  "prof",
  "ref",
  "refs",
  "sec",
  "secs",
  "sr",
  "st",
  "vs",
]);

const conditionalPeriodWords = new Set(["etc"]);

function isAsciiLetter(value: string) {
  return /^[A-Za-z]$/.test(value);
}

function isSentenceTerminator(value: string) {
  return value === "." || value === "!" || value === "?";
}

function isSentenceCloser(value: string) {
  return /^[)"'\]}]$/.test(value);
}

function nextNonSpaceIndex(text: string, index: number) {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function previousPeriodWord(text: string, periodIndex: number) {
  let cursor = periodIndex - 1;
  while (cursor >= 0 && isAsciiLetter(text[cursor])) {
    cursor -= 1;
  }
  return text.slice(cursor + 1, periodIndex).toLowerCase();
}

function fragmentWordCount(fragment: string) {
  return fragment.match(/[A-Za-z0-9]+/g)?.length ?? 0;
}

function isCaptionOrNumberLabel(fragment: string) {
  if (/^\d{1,3}(?:\.\d{1,3})*\.$/.test(fragment)) {
    return true;
  }
  return /(?:^|\s)(?:fig|figure|table|algorithm|alg|scheme|chart|appendix|section|sec|eq|equation)\.?\s*[A-Za-z]?\d+(?:\.\d+)*[a-z]?\.$/i.test(
    fragment,
  );
}

function isNonTerminalPeriod(text: string, periodIndex: number, sentenceStart: number, tokenEnd: number) {
  const previous = text[periodIndex - 1] ?? "";
  const next = text[periodIndex + 1] ?? "";
  if (/\d/.test(previous) && /\d/.test(next)) {
    return true;
  }

  const fragment = text.slice(sentenceStart, periodIndex + 1).trim();
  if (isCaptionOrNumberLabel(fragment) && fragmentWordCount(fragment) <= 4) {
    return true;
  }

  const beforePeriod = text.slice(Math.max(sentenceStart, periodIndex - 24), periodIndex + 1);
  if (/(?:\b[A-Za-z]\.){2,}$/.test(beforePeriod)) {
    return true;
  }

  const word = previousPeriodWord(text, periodIndex);
  const nextIndex = nextNonSpaceIndex(text, tokenEnd);
  const nextChar = text[nextIndex] ?? "";
  if (nonTerminalPeriodWords.has(word)) {
    return true;
  }
  if (conditionalPeriodWords.has(word) && nextChar && !/[A-Z]/.test(nextChar)) {
    return true;
  }
  if (word.length === 1 && /^[A-Za-z]$/.test(word)) {
    return true;
  }
  if (nextChar && /^[a-z]$/.test(nextChar)) {
    return true;
  }
  return false;
}

function isSmartSentenceBoundary(text: string, terminatorIndex: number, sentenceStart: number, tokenEnd: number) {
  if (tokenEnd < text.length && !/\s/.test(text[tokenEnd])) {
    return false;
  }
  const terminator = text[terminatorIndex];
  if (terminator === "." && isNonTerminalPeriod(text, terminatorIndex, sentenceStart, tokenEnd)) {
    return false;
  }
  return true;
}

function smartSentenceParts(text: string): string[] {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }
  const parts: string[] = [];
  let start = 0;
  let index = 0;
  while (index < normalized.length) {
    if (!isSentenceTerminator(normalized[index])) {
      index += 1;
      continue;
    }
    let tokenEnd = index + 1;
    while (tokenEnd < normalized.length && isSentenceCloser(normalized[tokenEnd])) {
      tokenEnd += 1;
    }
    if (isSmartSentenceBoundary(normalized, index, start, tokenEnd)) {
      const sentence = normalized.slice(start, tokenEnd).trim();
      if (sentence.length > 1) {
        parts.push(sentence);
      }
      start = nextNonSpaceIndex(normalized, tokenEnd);
      index = start;
      continue;
    }
    index += 1;
  }
  const tail = normalized.slice(start).trim();
  if (tail.length > 1) {
    parts.push(tail);
  }
  return parts;
}

function sentenceUnitsForPage(page: PageRecord | undefined): SentenceUnit[] {
  if (!page?.text) {
    return [];
  }
  const parts = smartSentenceParts(page.text);
  return (parts.length ? parts : [page.text.trim()]).map((source, index) => ({
    id: `p${page.pageNumber}-s${index}`,
    page: page.pageNumber,
    index,
    source,
  }));
}

function stripJsonFence(value: string) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function parseAiJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const repaired = value
      .replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u")
      .replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    if (repaired !== value) {
      return JSON.parse(repaired) as unknown;
    }
    throw error;
  }
}

function normalizeComparable(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeForMatch(value: string) {
  return normalizeComparable(value).toLowerCase();
}

function outlineAnchorDomId(id: string) {
  return `outline-anchor-${id}`;
}

function outlineDomToken(value: string) {
  const token = normalizeForMatch(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return token || "section";
}

function normalizedOutlineText(value: string) {
  return normalizeComparable(value)
    .replace(/\s+([,.;:!?%])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .trim();
}

function cleanOutlineTitle(value: string, fallback = "Section") {
  const title = normalizedOutlineText(
    value
      .replace(/^#{1,6}\s+/, "")
      .replace(/^\s*[-*]\s+/, "")
      .replace(/^\s*(?:page|p\.?)\s*\d+\s*[:\-]?\s*/i, "")
      .replace(/\s*\((?:page|p\.?)\s*\d+\)\s*/gi, " "),
  );
  const safe = title || fallback;
  return safe.length > 140 ? `${safe.slice(0, 137).trim()}...` : safe;
}


function outlineLevelFromLine(line: string) {
  const heading = line.match(/^\s*(#{1,6})\s+/);
  if (heading) {
    return Math.min(3, heading[1].length - 1);
  }
  const numbered = line.match(/^\s*(\d+(?:\.\d+)+)/);
  if (numbered) {
    return Math.min(3, numbered[1].split(".").length - 1);
  }
  const indent = line.match(/^(\s+)/)?.[1].length ?? 0;
  return Math.min(3, Math.floor(indent / 2));
}

function inferOutlinePage(line: string, title: string, pages: PageRecord[], fallbackPage: number) {
  const explicit = line.match(/\b(?:page|p\.?)\s*(\d{1,4})\b/i);
  if (explicit) {
    const page = Number(explicit[1]);
    if (page >= 1 && page <= Math.max(1, pages.length)) {
      return page;
    }
  }
  const normalizedTitle = normalizeForMatch(title).slice(0, 80);
  if (normalizedTitle.length >= 8) {
    const matched = pages.find(
      (page) =>
        normalizeForMatch(page.outlineLabel).includes(normalizedTitle) ||
        normalizeForMatch(page.text).includes(normalizedTitle),
    );
    if (matched) {
      return matched.pageNumber;
    }
  }
  return Math.max(1, Math.min(Math.max(1, pages.length), fallbackPage));
}

function medianNumber(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function textLinesFromBoxes(boxes: TextLayerBox[]) {
  const sorted = [...boxes]
    .filter((box) => box.text.trim())
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const groups: Array<{
    boxes: TextLayerBox[];
    top: number;
    bottom: number;
  }> = [];
  for (const box of sorted) {
    const midY = box.rect.top + box.rect.height / 2;
    let existing: (typeof groups)[number] | undefined;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      const groupMid = (group.top + group.bottom) / 2;
      const tolerance = Math.max(5, Math.min(box.rect.height, group.bottom - group.top) * 0.65);
      if (Math.abs(groupMid - midY) <= tolerance) {
        existing = group;
        break;
      }
    }
    if (existing) {
      existing.boxes.push(box);
      existing.top = Math.min(existing.top, box.rect.top);
      existing.bottom = Math.max(existing.bottom, box.rect.top + box.rect.height);
    } else {
      groups.push({
        boxes: [box],
        top: box.rect.top,
        bottom: box.rect.top + box.rect.height,
      });
    }
  }
  const lineRows = groups.flatMap((group) => {
    const sortedBoxes = [...group.boxes].sort((a, b) => a.rect.left - b.rect.left);
    const clusters: TextLayerBox[][] = [];
    for (const box of sortedBoxes) {
      const current = clusters[clusters.length - 1];
      const previous = current?.[current.length - 1];
      if (!current || !previous) {
        clusters.push([box]);
        continue;
      }
      const previousRight = previous.rect.left + previous.rect.width;
      const gap = box.rect.left - previousRight;
      const fontSize = Math.max(previous.fontSize, box.fontSize, 8);
      const columnGap = Math.max(42, fontSize * 3.2);
      if (gap > columnGap) {
        clusters.push([box]);
      } else {
        current.push(box);
      }
    }
    return clusters;
  });
  const lines = lineRows
    .map((lineBoxes) => {
      let text = "";
      for (const [index, box] of lineBoxes.entries()) {
        const previous = lineBoxes[index - 1];
        if (!previous) {
          text = box.text;
          continue;
        }
        const previousRight = previous.rect.left + previous.rect.width;
        const gap = box.rect.left - previousRight;
        const tightJoin =
          gap <= Math.max(4, Math.min(previous.fontSize, box.fontSize) * 0.28) ||
          /^[,.;:!?%)}\]]/.test(box.text) ||
          /[({\[]$/.test(previous.text);
        text += tightJoin ? box.text : ` ${box.text}`;
      }
      const left = Math.min(...lineBoxes.map((box) => box.rect.left));
      const top = Math.min(...lineBoxes.map((box) => box.rect.top));
      const right = Math.max(...lineBoxes.map((box) => box.rect.left + box.rect.width));
      const bottom = Math.max(...lineBoxes.map((box) => box.rect.top + box.rect.height));
      return {
        text: normalizedOutlineText(text),
        rect: {
          left,
          top,
          width: right - left,
          height: bottom - top,
        },
        fontSize: medianNumber(lineBoxes.map((box) => box.fontSize)),
        fontNames: [...new Set(lineBoxes.map((box) => box.fontName).filter(Boolean))],
        boxes: lineBoxes,
      } satisfies TextLine;
    })
    .filter((line) => line.text.length > 0);
  if (lines.length < 4) {
    return lines.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  }
  const minLeft = Math.min(...lines.map((line) => line.rect.left));
  const maxRight = Math.max(...lines.map((line) => line.rect.left + line.rect.width));
  const span = Math.max(1, maxRight - minLeft);
  const bodyLines = lines.filter((line) => {
    const width = line.rect.width;
    const center = line.rect.left + width / 2;
    return width < span * 0.72 && center > minLeft + span * 0.08 && center < maxRight - span * 0.08;
  });
  if (bodyLines.length < 4) {
    return lines.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  }
  const centers = bodyLines.map((line) => line.rect.left + line.rect.width / 2).sort((a, b) => a - b);
  let bestGap = 0;
  let splitAt = -1;
  for (let index = 1; index < centers.length; index += 1) {
    const gap = centers[index] - centers[index - 1];
    if (gap > bestGap) {
      bestGap = gap;
      splitAt = index;
    }
  }
  const twoColumn = splitAt > 0 && bestGap > Math.max(72, span * 0.16);
  if (!twoColumn) {
    return lines.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  }
  const splitX = (centers[splitAt - 1] + centers[splitAt]) / 2;
  const isFullWidth = (line: TextLine) => line.rect.width > span * 0.72;
  const columnFor = (line: TextLine) => {
    return line.rect.left + line.rect.width / 2 >= splitX ? 1 : 0;
  };
  const sortSegment = (segment: TextLine[]) =>
    segment.sort((a, b) => {
      const columnA = columnFor(a);
      const columnB = columnFor(b);
      if (columnA !== columnB) {
        return columnA - columnB;
      }
      return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
    });
  const ordered: TextLine[] = [];
  let segment: TextLine[] = [];
  for (const line of [...lines].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)) {
    if (isFullWidth(line)) {
      ordered.push(...sortSegment(segment));
      segment = [];
      ordered.push(line);
    } else {
      segment.push(line);
    }
  }
  ordered.push(...sortSegment(segment));
  return ordered;
}

function joinHyphenatedLineText(previous: string, next: string) {
  const left = previous.trimEnd();
  const right = next.trimStart();
  if (/[A-Za-z]-$/.test(left) && /^[A-Za-z]/.test(right)) {
    return `${left.slice(0, -1)}${right}`;
  }
  return `${left}\n${right}`;
}

function textFromOrderedLines(lines: TextLine[]) {
  return lines.reduce((text, line) => (text ? joinHyphenatedLineText(text, line.text) : line.text), "");
}

function textAndBoxesFromOrderedLines(lines: TextLine[]) {
  const text = textFromOrderedLines(lines);
  const boxes: TextLayerBox[] = [];
  let textCursor = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const previousLine = lineIndex > 0 ? lines[lineIndex - 1] : null;
    const joinedHyphen = Boolean(previousLine && /[A-Za-z]-$/.test(previousLine.text.trimEnd()) && /^[A-Za-z]/.test(line.text.trimStart()));
    if (lineIndex > 0 && !joinedHyphen) {
      textCursor += 1;
    }
    let lineCursor = 0;
    for (const [boxIndex, box] of line.boxes.entries()) {
      const raw = box.text.trim();
      if (!raw) {
        continue;
      }
      const isHyphenatedLineEnd = boxIndex === line.boxes.length - 1 && /[A-Za-z]-$/.test(raw);
      const indexText = isHyphenatedLineEnd ? raw.slice(0, -1) : raw;
      const itemIndex = line.text.indexOf(raw, lineCursor);
      const itemStart = textCursor + (itemIndex >= 0 ? itemIndex : lineCursor);
      const itemEnd = itemStart + indexText.length;
      lineCursor = (itemIndex >= 0 ? itemIndex : lineCursor) + raw.length;
      boxes.push({
        ...box,
        text: raw,
        start: itemStart,
        end: itemEnd,
      });
    }
    textCursor += line.text.length - (/[A-Za-z]-$/.test(line.text.trimEnd()) ? 1 : 0);
  }
  return { text, boxes };
}

function dehyphenateLineBreaks(text: string) {
  return text
    .replace(/([A-Za-z])-\s*\n\s*([A-Za-z])/g, "$1$2")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pageTextFromPdfItems(
  items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }>,
  viewport: { width: number; height: number; transform: number[] },
  scale: number,
) {
  const { text } = textBoxesFromPdfItems(items, viewport, scale);
  const dehyphenated = dehyphenateLineBreaks(text);
  if (dehyphenated) {
    return dehyphenated;
  }
  return items.map((item) => item.str ?? "").join(" ").replace(/\s+/g, " ").trim();
}

function outlineLevelFromTitle(title: string) {
  const appendix = title.match(/^appendix\s+[A-Z0-9]+(?:\.(\d+))*\b/i);
  if (appendix) {
    const depth = (title.match(/\./g) ?? []).length;
    return clampNumber(depth, 0, 3);
  }
  const numbered = title.match(/^(\d+(?:\.\d+)*)\b/);
  if (!numbered) {
    return 0;
  }
  return clampNumber(numbered[1].split(".").length - 1, 0, 3);
}

const commonOutlineHeadingPattern =
  /^(abstract|introduction|background|related works?|preliminar(?:y|ies)|problem(?: statement| formulation)?|motivation|overview|contributions?|method(?:s|ology)?|approach|model(?:s)?|architecture|design|implementation|algorithm|analysis|experiment(?:s)?|experimental setup|evaluation|results?|ablation(?: study|s)?|discussion|limitations?|conclusion|references|bibliography|acknowledg(?:e)?ments?|appendix)(?:\b|[\s:.-]|$)/i;

function numberedOutlineHeading(value: string) {
  const text = normalizedOutlineText(value);
  const match = text.match(/^(\d{1,2}(?:\.\d{1,2}){0,3}|Appendix\s+[A-Z0-9]+(?:\.\d+)*)(?:[.)]|\s+|(?=[A-Z]))\s*(.+)$/i);
  if (!match) {
    return null;
  }
  const label = match[1];
  const title = match[2].trim();
  if (/^\d+$/.test(label)) {
    const number = Number(label);
    if (number < 1 || number > 20) {
      return null;
    }
  }
  return { label, title };
}

function strictNumberedOutlineHeading(value: string) {
  const text = normalizedOutlineText(value)
    .replace(/^\s*[-*]\s*/, "")
    .replace(/^\s*(?:p\.?|page)\s*\d+\s*[:\-]\s*/i, "")
    .trim();
  const match = text.match(/^(\d{1,2}(?:\.\d{1,2}){0,4})(?:[.)]\s*|\s+|(?=[A-Z]))(.+)$/);
  if (!match) {
    return null;
  }
  const label = match[1];
  const title = match[2].trim();
  if (!title || !/[\p{L}]/u.test(title)) {
    return null;
  }
  const parts = label.split(".").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0 || part > 99) || parts[0] < 1 || parts[0] > 30) {
    return null;
  }
  return { label, title, normalizedTitle: `${label} ${title}` };
}


function isOutlineHeadingStart(text: string) {
  return Boolean(numberedOutlineHeading(text));
}

function commonOutlineHeadingTitle(text: string) {
  const normalized = normalizedOutlineText(text);
  const relatedWorks = normalized.match(/^(related works?)(?:\b|[\s:.-]|$)/i);
  if (relatedWorks) {
    return relatedWorks[1].replace(/\s+/g, " ");
  }
  const match = normalized.match(commonOutlineHeadingPattern);
  return match?.[1]?.replace(/\s+/g, " ") ?? "";
}

function isCommonOutlineHeading(text: string) {
  return Boolean(commonOutlineHeadingTitle(text));
}

function cleanDetectedOutlineTitle(value: string) {
  const title = cleanOutlineTitle(value, "");
  return strictNumberedOutlineHeading(title)?.normalizedTitle ?? "";
}

function isPlausibleDetectedOutlineTitle(title: string) {
  const text = normalizedOutlineText(title);
  if (text.length < 3 || text.length > 140) {
    return false;
  }
  const numbered = numberedOutlineHeading(text);
  if (!numbered && !isCommonOutlineHeading(text)) {
    return false;
  }
  const body = numbered ? numbered.title : text;
  const letterCount = (body.match(/[\p{L}]/gu) ?? []).length;
  const digitCount = (body.match(/\d/g) ?? []).length;
  const mathSymbolCount = (body.match(/[=<>+\-*/^_{}\\|]/g) ?? []).length;
  if (letterCount < 2) {
    return false;
  }
  if (!isCommonOutlineHeading(text) && digitCount > Math.max(2, letterCount)) {
    return false;
  }
  return mathSymbolCount <= Math.max(2, Math.floor(letterCount * 0.35));
}

function isPlausibleAiOutlineTitle(title: string) {
  const text = normalizedOutlineText(title);
  if (text.length < 3 || text.length > 140) {
    return false;
  }
  const letterCount = (text.match(/[\p{L}]/gu) ?? []).length;
  const digitCount = (text.match(/\d/g) ?? []).length;
  const mathSymbolCount = (text.match(/[=<>+\-*/^_{}\\|]/g) ?? []).length;
  if (letterCount < 2) {
    return false;
  }
  if (digitCount > Math.max(4, letterCount * 1.2)) {
    return false;
  }
  return mathSymbolCount <= Math.max(2, Math.floor(letterCount * 0.45));
}


function isLikelyOutlineHeading(line: TextLine, medianFont: number, leftMargin: number, pageWidth: number) {
  const text = line.text;
  if (text.length < 4 || text.length > 180) {
    return false;
  }
  const numbered = strictNumberedOutlineHeading(text);
  const startsLikeHeading = Boolean(numbered);
  if (!startsLikeHeading) {
    return false;
  }
  const remainder = numbered ? numbered.title : text;
  const letterCount = (remainder.match(/[\p{L}]/gu) ?? []).length;
  if (letterCount < 2) {
    return false;
  }
  const mathSymbolCount = (remainder.match(/[=<>+\-*/^_{}\\|]/g) ?? []).length;
  if (mathSymbolCount > Math.max(3, letterCount * 1.2) && !/[\p{L}]/u.test(remainder)) {
    return false;
  }
  const lineCenter = line.rect.left + line.rect.width / 2;
  const likelyRightColumn = line.rect.left > pageWidth * 0.42 && lineCenter < pageWidth * 0.98;
  if (!startsLikeHeading && !likelyRightColumn && line.rect.left > leftMargin + pageWidth * 0.18) {
    return false;
  }
  const boldish = line.fontNames.some((name) => /bold|black|heavy|demi|semibold/i.test(name));
  const prominent = line.fontSize >= medianFont * 0.96 || boldish;
  if (!prominent && line.rect.width > pageWidth * 0.88) {
    return false;
  }
  if (/[.!?]$/.test(text) && remainder.length > 36) {
    return false;
  }
  if (!isPlausibleDetectedOutlineTitle(cleanDetectedOutlineTitle(text))) {
    return false;
  }
  return true;
}

function detectedOutlineAnchorsForPage(
  pageNumber: number,
  boxes: TextLayerBox[],
  pageWidth: number,
  pageHeight: number,
) {
  const lines = textLinesFromBoxes(boxes);
  if (lines.length === 0) {
    return [];
  }
  const leftMargin = Math.min(...lines.map((line) => line.rect.left));
  const medianFont = medianNumber(lines.map((line) => line.fontSize).filter((value) => value > 0));
  const anchors: OutlineAnchor[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!isLikelyOutlineHeading(line, medianFont, leftMargin, pageWidth)) {
      continue;
    }
    let merged = line.text;
    let mergedRect = { ...line.rect };
    let lastIndex = index;
    if (isOutlineHeadingStart(line.text)) {
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const next = lines[cursor];
        const verticalGap = next.rect.top - (mergedRect.top + mergedRect.height);
        const similarLeft = Math.abs(next.rect.left - line.rect.left) <= 28;
        const similarFont = Math.abs(next.fontSize - line.fontSize) <= 2.5;
        const nextStartsHeading = isOutlineHeadingStart(next.text) || isCommonOutlineHeading(next.text);
        if (verticalGap > line.rect.height * 1.1 || !similarLeft || !similarFont || nextStartsHeading) {
          break;
        }
        const nextTitle = normalizedOutlineText(joinHyphenatedLineText(merged, next.text).replace(/\n/g, " "));
        if (!isPlausibleDetectedOutlineTitle(cleanDetectedOutlineTitle(nextTitle))) {
          break;
        }
        merged = nextTitle;
        const right = Math.max(mergedRect.left + mergedRect.width, next.rect.left + next.rect.width);
        const bottom = Math.max(mergedRect.top + mergedRect.height, next.rect.top + next.rect.height);
        mergedRect = {
          left: Math.min(mergedRect.left, next.rect.left),
          top: Math.min(mergedRect.top, next.rect.top),
          width: right - Math.min(mergedRect.left, next.rect.left),
          height: bottom - Math.min(mergedRect.top, next.rect.top),
        };
        lastIndex = cursor;
      }
    }
    const title = cleanDetectedOutlineTitle(merged);
    if (!title || !isPlausibleDetectedOutlineTitle(title)) {
      continue;
    }
    const dedupeKey = `${pageNumber}:${outlineLevelFromTitle(title)}:${normalizeForMatch(title)}`;
    if (anchors.some((anchor) => `${anchor.page}:${anchor.level}:${normalizeForMatch(anchor.title)}` === dedupeKey)) {
      index = lastIndex;
      continue;
    }
    anchors.push({
      id: `${pageNumber}-${Math.round(mergedRect.top)}-${outlineDomToken(title).slice(0, 48)}`,
      page: pageNumber,
      title,
      level: outlineLevelFromTitle(title),
      top: clampNumber(mergedRect.top - 8, 0, Math.max(0, pageHeight - 2)),
      left: mergedRect.left,
      width: mergedRect.width,
      height: mergedRect.height,
    });
    index = lastIndex;
  }
  return anchors;
}

function aiOutlineRowsFromResult(result: AiResultRecord, pages: PageRecord[]): OutlineRow[] {
  const readable = getReadableAiOutput(result);
  try {
    const parsed = parseAiJson(stripJsonFence(cleanAiOutput(readable)));
    const rows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { outline?: unknown }).outline)
        ? (parsed as { outline: unknown[] }).outline
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { sections?: unknown }).sections)
          ? (parsed as { sections: unknown[] }).sections
          : [];
    const parsedRows = rows
      .map((row, order) => (row && typeof row === "object" ? outlineRowFromAiRecord(row as Record<string, unknown>, order, pages) : null))
      .filter((row): row is OutlineRow & { order: number } => row !== null)
      .sort(compareOutlineRows)
      .slice(0, 120)
      .map(({ order: _order, ...row }) => row);
    if (parsedRows.length > 0) {
      return parsedRows;
    }
  } catch {
    // Fall back to line parsing below.
  }
  const lines = readable
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 2 && !/^local explanation draft/i.test(line));
  const rows: Array<OutlineRow & { order: number }> = [];
  for (const [order, line] of lines.entries()) {
    const title = cleanStrictNumberedOutlineTitle(line);
    if (!title || /^(no extracted|task queued|agent)/i.test(title) || !isPlausibleAiOutlineTitle(title)) {
      continue;
    }
    const page = inferOutlinePage(line, title, pages, rows.length + 1);
    rows.push({
      id: `ai-outline-${rows.length}-${page}-${title}`,
      page,
      title,
      level: outlineLevelFromTitle(title),
      source: "ai",
      order,
    });
    if (rows.length >= 60) {
      break;
    }
  }
  return rows
    .sort((a, b) => a.page - b.page || a.order - b.order)
    .map(({ order: _order, ...row }) => row);
}

function parseAiOutlineRows(results: AiResultRecord[], pages: PageRecord[]): OutlineRow[] {
  const candidates = results.filter(
    (result) =>
      result.taskType.toString() === "outlineDocument" &&
      result.status !== "pending" &&
      result.status !== "failed",
  );
  for (const result of candidates) {
    const rows = aiOutlineRowsFromResult(result, pages);
    if (rows.length > 0) {
      return rows;
    }
  }
  return [];
}

function isFreshPendingOutlineResult(result: AiResultRecord) {
  if (result.taskType.toString() !== "outlineDocument" || result.status !== "pending") {
    return false;
  }
  const createdAt = new Date(result.createdAt).getTime();
  if (!Number.isFinite(createdAt)) {
    return true;
  }
  return Date.now() - createdAt < 15 * 60 * 1000;
}

function hasFreshPendingOutlineResult(results: AiResultRecord[]) {
  return results.some(isFreshPendingOutlineResult);
}

function outlineRowsFromAnchors(anchors: OutlineAnchor[]) {
  return anchors
    .slice()
    .sort((a, b) => a.page - b.page || a.top - b.top)
    .map(
      (anchor) =>
        ({
          id: anchor.id,
          page: anchor.page,
          title: anchor.title,
          level: anchor.level,
          source: "detected",
          anchorId: anchor.id,
        }) satisfies OutlineRow,
    );
}

function cleanStrictNumberedOutlineTitle(value: string) {
  const stripped = normalizedOutlineText(value)
    .replace(/^\s*[-*]\s*/, "")
    .replace(/^\s*(?:p\.?|page)\s*\d+\s*[:\-]\s*/i, "")
    .trim();
  return strictNumberedOutlineHeading(stripped)?.normalizedTitle ?? "";
}

function outlineRowFromAiRecord(record: Record<string, unknown>, order: number, pages: PageRecord[]): (OutlineRow & { order: number }) | null {
  const number = String(record.number ?? record.label ?? record.section ?? "").trim();
  const rawTitle = String(record.title ?? record.heading ?? record.text ?? record.anchorText ?? "").trim();
  const candidateTitle = cleanStrictNumberedOutlineTitle(number && rawTitle && !rawTitle.startsWith(number) ? `${number} ${rawTitle}` : rawTitle || number);
  if (!candidateTitle || !isPlausibleAiOutlineTitle(candidateTitle)) {
    return null;
  }
  const rawPage = Number(record.page ?? record.pageNumber ?? record.p);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.round(rawPage) : inferOutlinePage("", candidateTitle, pages, order + 1);
  const rawLevel = Number(record.level);
  return {
    id: `ai-outline-${order}-${page}-${candidateTitle}`,
    page,
    title: candidateTitle,
    level: Number.isFinite(rawLevel) ? clampNumber(Math.round(rawLevel), 0, 4) : outlineLevelFromTitle(candidateTitle),
    source: "ai",
    order,
  };
}

function fallbackOutlineRows(pdfRows: OutlineRow[], pages: PageRecord[]): OutlineRow[] {
  if (pdfRows.length) {
    return pdfRows.slice(0, 60);
  }
  return pages.slice(0, 36).map((page) => ({
    id: `page-outline-${page.pageNumber}`,
    page: page.pageNumber,
    title: cleanOutlineTitle(page.outlineLabel || page.text, `Page ${page.pageNumber}`),
    level: 0,
    source: "page",
  }));
}

function outlineCanonicalKey(title: string) {
  const cleaned = cleanOutlineTitle(title, "");
  const numbered = numberedOutlineHeading(cleaned);
  if (numbered) {
    return `number:${numbered.label.toLowerCase()}`;
  }
  return `title:${normalizeForMatch(cleaned)
    .replace(/^\d{1,2}(?:\.\d{1,2}){0,3}\s*/, "")
    .replace(/\bworks\b/g, "work")
    .replace(/[^a-z0-9]+/g, "")}`;
}

function outlineNumberParts(title: string) {
  const label = numberedOutlineHeading(title)?.label ?? "";
  if (!/^\d+(?:\.\d+)*$/.test(label)) {
    return [];
  }
  return label.split(".").map((part) => Number(part));
}

function compareOutlineRows(a: OutlineRow, b: OutlineRow) {
  const aParts = outlineNumberParts(a.title);
  const bParts = outlineNumberParts(b.title);
  if (aParts.length && bParts.length) {
    const length = Math.max(aParts.length, bParts.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (aParts[index] ?? -1) - (bParts[index] ?? -1);
      if (diff !== 0) {
        return diff;
      }
    }
  }
  return a.page - b.page || a.level - b.level || a.title.localeCompare(b.title);
}

function mergedOutlineRows(...groups: OutlineRow[][]): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const row of group) {
      if (!row.title.trim() || row.source === "pending") {
        continue;
      }
      const key = outlineCanonicalKey(row.title);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push(row);
    }
  }
  return rows
    .sort(compareOutlineRows)
    .slice(0, 120);
}

function strictNumberedOutlineRows(rows: OutlineRow[]) {
  const seen = new Set<string>();
  return rows
    .map((row) => {
      const title = cleanStrictNumberedOutlineTitle(row.title);
      return title ? { ...row, title, level: outlineLevelFromTitle(title) } : null;
    })
    .filter((row): row is OutlineRow => row !== null)
    .sort(compareOutlineRows)
    .filter((row) => {
      const key = outlineCanonicalKey(row.title);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .slice(0, 120);
}

function readerOutlineRows(
  results: AiResultRecord[],
  pdfRows: OutlineRow[],
  pages: PageRecord[],
  anchors: OutlineAnchor[],
  ui: UiStrings = uiStrings.ko,
): OutlineRow[] {
  const aiRows = strictNumberedOutlineRows(parseAiOutlineRows(results, pages));
  if (aiRows.length > 0) {
    return aiRows;
  }
  const pdfNumberedRows = strictNumberedOutlineRows(pdfRows);
  if (pdfNumberedRows.length > 0) {
    return pdfNumberedRows;
  }
  const detectedRows = strictNumberedOutlineRows(outlineRowsFromAnchors(anchors));
  if (detectedRows.length > 0) {
    return detectedRows;
  }
  if (hasFreshPendingOutlineResult(results)) {
    return [
      {
        id: "ai-outline-pending",
        page: 1,
        title: ui.aiOutlinePending,
        level: 0,
        source: "pending" as const,
      },
    ];
  }
  return [];
}

function parseTranslationLines(outputText: string, expectedCount: number): string[] {
  const readable = stripJsonFence(cleanAiOutput(outputText));
  if (!readable) {
    return [];
  }
  try {
    const parsed = parseAiJson(readable);
    const rows = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { pairs?: unknown }).pairs)
        ? (parsed as { pairs: unknown[] }).pairs
        : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { translations?: unknown }).translations)
          ? (parsed as { translations: unknown[] }).translations
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { sentences?: unknown }).sentences)
        ? (parsed as { sentences: unknown[] }).sentences
        : [];
    const translations = rows
      .map((row) => {
        if (typeof row === "string") {
          return row;
        }
        if (typeof row === "object" && row !== null) {
          const record = row as Record<string, unknown>;
          return String(record.translation ?? record.ko ?? record.korean ?? record.text ?? "");
        }
        return "";
      })
      .map((line) => line.trim())
      .filter(Boolean);
    if (translations.length) {
      return translations;
    }
  } catch {
    // Fall back to line or sentence parsing below.
  }
  const lines = readable
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line && !/^translation task queued/i.test(line) && !/^source text:/i.test(line));
  if (lines.length >= Math.min(2, expectedCount)) {
    return lines;
  }
  return smartSentenceParts(readable);
}

function parseTranslationPairs(outputText: string): TranslationPair[] {
  const readable = stripJsonFence(cleanAiOutput(outputText));
  if (!readable) {
    return [];
  }
  const parseSourceIds = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      return value
        .map((item) => String(item ?? "").trim())
        .filter((item) => /^p\d+-s\d+$/.test(item));
    }
    if (typeof value === "string") {
      return value
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter((item) => /^p\d+-s\d+$/.test(item));
    }
    return [];
  };
  try {
    const parsed = parseAiJson(readable);
    const rows = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { pairs?: unknown }).pairs)
        ? (parsed as { pairs: unknown[] }).pairs
        : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { translations?: unknown }).translations)
          ? (parsed as { translations: unknown[] }).translations
          : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { sentences?: unknown }).sentences)
            ? (parsed as { sentences: unknown[] }).sentences
            : [];
    return rows
      .map((row, index): TranslationPair | null => {
        if (typeof row === "string") {
          return { id: `t${index}`, source: "", translation: row.trim() };
        }
        if (typeof row !== "object" || row === null) {
          return null;
        }
        const record = row as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const sourceIds = parseSourceIds(
          record.sourceIds ?? record.source_ids ?? record.sentenceIds ?? record.sentence_ids ?? record.ids ?? (id ? [id] : []),
        );
        const source = String(
          record.source ??
            record.original ??
            record.input ??
            record.sentence ??
            record.en ??
            record.english ??
            "",
        ).trim();
        const translation = String(
          record.translation ??
            record.translated ??
            record.ko ??
            record.korean ??
            (source ? record.text : "") ??
            "",
        ).trim();
        if (!translation) {
          return null;
        }
        return {
          id: id || undefined,
          sourceIds,
          source,
          translation,
        };
      })
      .filter((pair): pair is TranslationPair => pair !== null);
  } catch {
    const pairs: TranslationPair[] = [];
    let pendingSource = "";
    for (const rawLine of readable.split(/\n+/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const sourceMatch = line.match(/^(?:source|original)\s*[:>\-]\s*(.+)$/i);
      if (sourceMatch) {
        pendingSource = sourceMatch[1].trim();
        continue;
      }
      const translationMatch = line.match(/^(?:translation|translated)\s*[:>\-]\s*(.+)$/i);
      if (translationMatch) {
        pairs.push({ sourceIds: [], source: pendingSource, translation: translationMatch[1].trim() });
        pendingSource = "";
      }
    }
    return pairs;
  }
}

function parseTranslationMap(outputText: string): Map<string, string> {
  const readable = stripJsonFence(cleanAiOutput(outputText));
  const map = new Map<string, string>();
  if (!readable) {
    return map;
  }
  try {
    const parsed = parseAiJson(readable);
    const rows = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { sentences?: unknown }).sentences)
        ? (parsed as { sentences: unknown[] }).sentences
        : [];
    for (const row of rows) {
      if (typeof row !== "object" || row === null) {
        continue;
      }
      const record = row as Record<string, unknown>;
      const id = String(record.id ?? "");
      const translation = String(record.translation ?? record.ko ?? record.korean ?? record.text ?? "").trim();
      if (id && translation) {
        map.set(id, translation);
      }
    }
  } catch {
    for (const line of readable.split(/\n+/)) {
      const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*[:>\-]\s*(.+)$/);
      if (match) {
        map.set(match[1], match[2].trim());
      }
    }
  }
  return map;
}

function colorForHighlightTag(tag: string) {
  const normalized = tag.toLowerCase();
  if (/method|algorithm|model|experiment/.test(normalized)) {
    return "#b8e986";
  }
  if (/result|performance|evaluation|score/.test(normalized)) {
    return "#ff7f6e";
  }
  if (/limit|limitation|problem|error|failure/.test(normalized)) {
    return "#f6c85f";
  }
  return "#4ecdc4";
}


function parseAutoHighlightCandidates(outputText: string, fallbackPage: number): AutoHighlightCandidate[] {
  const readable = stripJsonFence(cleanAiOutput(outputText));
  if (!readable) {
    return [];
  }
  try {
    const parsed = parseAiJson(readable);
    const rows = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { highlights?: unknown }).highlights)
        ? (parsed as { highlights: unknown[] }).highlights
        : [];
    return rows
      .map((row) => {
        if (typeof row !== "object" || row === null) {
          return null;
        }
        const record = row as Record<string, unknown>;
        const text = String(record.text ?? record.sentence ?? record.quote ?? "").trim();
        if (!text) {
          return null;
        }
        return {
          page: Number(record.page ?? fallbackPage) || fallbackPage,
          text,
          tag: String(record.tag ?? record.category ?? "AI").trim() || "AI",
          reason: String(record.reason ?? record.comment ?? "").trim(),
        };
      })
      .filter(Boolean) as AutoHighlightCandidate[];
  } catch {
    return readable
      .split(/\n+/)
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
      .filter((line) => line.length > 12)
      .slice(0, 6)
      .map((line) => ({
        page: fallbackPage,
        text: line.replace(/^["']|["']$/g, ""),
        tag: "AI",
        reason: "",
      }));
  }
}

const wordStopWords = new Set([
  "about",
  "above",
  "after",
  "again",
  "against",
  "also",
  "although",
  "among",
  "because",
  "before",
  "between",
  "both",
  "could",
  "does",
  "doing",
  "done",
  "each",
  "from",
  "have",
  "having",
  "into",
  "more",
  "most",
  "other",
  "over",
  "paper",
  "same",
  "some",
  "than",
  "that",
  "their",
  "there",
  "these",
  "this",
  "those",
  "through",
  "under",
  "using",
  "were",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
]);

const phraseConnectorWords = new Set(["and", "as", "by", "for", "from", "in", "of", "on", "to", "via", "with"]);
const technicalSuffixPattern = /(ability|able|al|ance|ence|ation|ative|ator|ence|ency|ent|graph|hood|ibility|ible|ical|ics|ing|ion|ism|ity|ive|ization|ized|izer|less|ment|ness|ology|ous|ship|tion|ty)$/;
const technicalPrefixPattern = /^(amort|auto|bio|chrono|co|cross|de|dis|embedding|graph|hyper|inter|intra|latent|meta|micro|multi|neural|non|post|pre|pseudo|re|self|semi|sub|super|trans|un|zero)/;
const basicKoreanDictionary: Record<string, string> = {
  accuracy: "\uc815\ud655\ub3c4",
  algorithm: "\uc54c\uace0\ub9ac\uc998",
  analysis: "\ubd84\uc11d",
  answer: "\ub2f5",
  approach: "\uc811\uadfc\ubc95",
  architecture: "\uad6c\uc870",
  attention: "\uc5b4\ud150\uc158",
  baseline: "\uae30\uc900 \ubaa8\ub378",
  benchmark: "\ubca4\uce58\ub9c8\ud06c",
  classification: "\ubd84\ub958",
  context: "\ub9e5\ub77d",
  data: "\ub370\uc774\ud130",
  dataset: "\ub370\uc774\ud130\uc14b",
  depth: "\uae4a\uc774",
  difficulty: "\ub09c\uc774\ub3c4",
  document: "\ubb38\uc11c",
  dynamics: "\ub3d9\uc5ed\ud559",
  error: "\uc624\ub958",
  evaluation: "\ud3c9\uac00",
  experiment: "\uc2e4\ud5d8",
  feature: "\ud2b9\uc9d5",
  framework: "\ud504\ub808\uc784\uc6cc\ud06c",
  inference: "\ucd94\ub860",
  input: "\uc785\ub825",
  interplay: "\uc0c1\ud638\uc791\uc6a9",
  known: "\uc54c\ub824\uc9c4",
  language: "\uc5b8\uc5b4",
  learning: "\ud559\uc2b5",
  method: "\ubc29\ubc95",
  minimalist: "\ubbf8\ub2c8\uba40\ud55c",
  model: "\ubaa8\ub378",
  network: "\ub124\ud2b8\uc6cc\ud06c",
  optimization: "\ucd5c\uc801\ud654",
  optimizer: "\ucd5c\uc801\ud654 \uc54c\uace0\ub9ac\uc998",
  output: "\ucd9c\ub825",
  paper: "\ub17c\ubb38",
  parameter: "\ub9e4\uac1c\ubcc0\uc218",
  performance: "\uc131\ub2a5",
  prediction: "\uc608\uce21",
  prompt: "\ud504\ub86c\ud504\ud2b8",
  result: "\uacb0\uacfc",
  reward: "\ubcf4\uc0c1",
  sample: "\uc0d8\ud50c",
  search: "\uac80\uc0c9",
  sentence: "\ubb38\uc7a5",
  sharpness: "\ub0a0\uce74\ub85c\uc6c0",
  signal: "\uc2e0\ud638",
  stability: "\uc548\uc815\uc131",
  stabilization: "\uc548\uc815\ud654",
  stochasticity: "\ud655\ub960\uc131",
  system: "\uc2dc\uc2a4\ud15c",
  task: "\uacfc\uc81c",
  token: "\ud1a0\ud070",
  training: "\ud559\uc2b5",
  transformer: "\ud2b8\ub79c\uc2a4\ud3ec\uba38",
  variable: "\ubcc0\uc218",
};


function basicDictionaryMeaning(term: string) {
  const key = normalizeWordKey(term);
  if (basicKoreanDictionary[key]) {
    return basicKoreanDictionary[key];
  }
  const singular =
    key.endsWith("ies") && key.length > 4
      ? `${key.slice(0, -3)}y`
      : key.endsWith("es") && key.length > 4
        ? key.slice(0, -2)
        : key.endsWith("s") && key.length > 3
          ? key.slice(0, -1)
          : "";
  return singular ? basicKoreanDictionary[singular] ?? "" : "";
}

function onlineDictionaryCacheFromSettings(settings: Record<string, string>): OnlineDictionaryCache {
  try {
    const parsed = JSON.parse(settings[onlineDictionaryCacheSettingKey] || "{}") as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const cache: OnlineDictionaryCache = {};
    for (const [rawKey, rawValue] of Object.entries(parsed as Record<string, unknown>)) {
      const key = normalizeWordKey(rawKey);
      if (!key || !rawValue || typeof rawValue !== "object") {
        continue;
      }
      const record = rawValue as Record<string, unknown>;
      cache[key] = {
        meaning: String(record.meaning ?? ""),
        source: String(record.source ?? "WiktApi/Wiktionary"),
        fetchedAt: String(record.fetchedAt ?? nowIso()),
        parserVersion: typeof record.parserVersion === "string" ? record.parserVersion : undefined,
      };
    }
    return cache;
  } catch {
    return {};
  }
}

function documentWordListSettingKey(documentId: string) {
  return `${documentWordListSettingPrefix}${documentId}`;
}

function normalizeWordKey(value: string) {
  return value
    .replace(/\u2019/g, "'")
    .replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isMeaningfulEnglishWord(value: string) {
  const word = normalizeWordKey(value);
  if (word.length < 3 || wordStopWords.has(word)) {
    return false;
  }
  if (!/^[a-z][a-z'-]*[a-z]$|^[a-z]{3,}$/.test(word)) {
    return false;
  }
  return !/^(?:[a-z])$/.test(word);
}

function isPhraseConnector(word: string) {
  return phraseConnectorWords.has(normalizeWordKey(word));
}

function isMeaningfulEnglishTerm(value: string) {
  const term = normalizeWordKey(value);
  if (!term) {
    return false;
  }
  if (!term.includes(" ")) {
    return isMeaningfulEnglishWord(term);
  }
  return false;
}

function cleanDictionaryMeaning(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/^[-,;:(){}\[\]\s]+|[-,;:(){}\[\]\s]+$/g, "")
    .trim();
}

function hasKoreanText(value: string) {
  return /[\uac00-\ud7a3]/.test(value);
}

function koreanDictionaryMeaningParts(value: string) {
  const cleaned = cleanDictionaryMeaning(value).replace(/[A-Za-z\u00c0-\u024f\u1d00-\u1d7f\u0250-\u02af]+/g, " ");
  return cleaned
    .split(/[,;\/|]+/)
    .map((part) =>
      part
        .replace(/[^\uac00-\ud7a3\s-]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^-+|-+$/g, "")
        .trim(),
    )
    .filter((part) => hasKoreanText(part) && part.length <= 40);
}

function normalizeKoreanDictionaryMeaning(value: string) {
  return [...new Set(koreanDictionaryMeaningParts(value))].slice(0, 6).join(", ");
}

function normalizeOnlineDictionaryMeaning(value: string) {
  return normalizeKoreanDictionaryMeaning(value);
}

function addKoreanDictionaryMeaning(value: string, output: Set<string>, record?: Record<string, unknown>) {
  if (record && isNoisyDictionaryRecord(record)) {
    return;
  }
  for (const meaning of koreanDictionaryMeaningParts(value)) {
    output.add(meaning);
  }
}

function isCurrentDictionaryEntry(entry: WordMeaningEntry) {
  return entry.source !== "dictionary" || entry.context === onlineDictionarySourceLabel;
}

function hasUsableWordMeaning(entries: WordMeaningEntry[] | undefined) {
  return Boolean(
    entries?.some((entry) =>
      entry.source === "dictionary"
        ? isCurrentDictionaryEntry(entry) && Boolean(normalizeOnlineDictionaryMeaning(entry.meaning))
        : Boolean(entry.meaning.trim()),
    ),
  );
}

function displayWordMeaning(entry: WordMeaningEntry) {
  return entry.source === "dictionary" ? normalizeOnlineDictionaryMeaning(entry.meaning) : entry.meaning.trim();
}

function displayWordMeaningEntries(entries: WordMeaningEntry[]) {
  return entries
    .filter(isCurrentDictionaryEntry)
    .map((entry) => ({ ...entry, meaning: displayWordMeaning(entry) }))
    .filter((entry) => entry.meaning.length > 0);
}

function dictionaryRecordText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(dictionaryRecordText).join(" ");
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

function isNoisyDictionaryRecord(record: Record<string, unknown>) {
  const tagText = [
    record.tags,
    record.raw_tags,
    record.topics,
    record.qualifier,
    record.qualifiers,
    record.note,
    record.notes,
    record.usage,
  ]
    .map(dictionaryRecordText)
    .join(" ")
    .toLowerCase();
  return /north korea|north korean|dprk|archaic|obsolete|rare|dialect|dialectal|nonstandard|misspelling|romanization|pronunciation/.test(tagText);
}


function isKoreanDictionaryRecord(record: Record<string, unknown>) {
  const langCode = String(record.lang_code ?? record.code ?? record.langCode ?? "").toLowerCase();
  const lang = String(record.lang ?? record.language ?? record.name ?? "").toLowerCase();
  const nestedLanguage = record.language && typeof record.language === "object" ? (record.language as Record<string, unknown>) : null;
  const nestedCode = String(nestedLanguage?.code ?? "").toLowerCase();
  const nestedName = String(nestedLanguage?.name ?? "").toLowerCase();
  return (
    langCode === "ko" ||
    nestedCode === "ko" ||
    lang === "korean" ||
    lang === "\ud55c\uad6d\uc5b4" ||
    lang.includes("korean") ||
    nestedName === "korean" ||
    nestedName === "\ud55c\uad6d\uc5b4" ||
    nestedName.includes("korean")
  );
}

function collectKoreanDictionaryValues(value: unknown, output: Set<string>, depth = 0, inTranslations = false) {
  if (depth > 8 || value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKoreanDictionaryValues(item, output, depth + 1, inTranslations);
    }
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  const record = value as Record<string, unknown>;
  if (inTranslations && isKoreanDictionaryRecord(record) && !isNoisyDictionaryRecord(record)) {
    for (const field of ["word", "translation", "text", "term", "trans_word"]) {
      const raw = record[field];
      if (typeof raw === "string") {
        addKoreanDictionaryMeaning(raw, output, record);
      }
    }
    return;
  }
  for (const [key, nested] of Object.entries(record)) {
    if (["forms", "sounds", "pronunciations", "hyphenation", "synonyms", "antonyms", "derived", "related"].includes(key)) {
      continue;
    }
    collectKoreanDictionaryValues(nested, output, depth + 1, inTranslations || key === "translations");
  }
}

function parseOnlineDictionaryMeaning(payload: unknown, rootIsTranslations = false) {
  const values = new Set<string>();
  collectKoreanDictionaryValues(payload, values, 0, rootIsTranslations);
  return [...values]
    .filter((item) => item.length > 0 && item.length <= 80)
    .slice(0, 6)
    .join(", ");
}

function parseMachineTranslatedKoreanMeaning(payload: unknown) {
  const values = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string") {
      for (const meaning of koreanDictionaryMeaningParts(value)) {
        values.add(meaning);
      }
    }
  };
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const responseData = record.responseData && typeof record.responseData === "object" ? (record.responseData as Record<string, unknown>) : null;
    add(responseData?.translatedText);
    if (Array.isArray(record.matches)) {
      for (const match of record.matches) {
        if (match && typeof match === "object") {
          add((match as Record<string, unknown>).translation);
        }
      }
    }
  }
  return [...values]
    .filter((item) => item.length > 0 && item.length <= 80)
    .slice(0, 4)
    .join(", ");
}

function dictionaryLookupCandidates(term: string) {
  const key = normalizeWordKey(term);
  const candidates = new Set<string>(key && !key.includes(" ") ? [key] : []);
  const add = (candidate: string) => {
    const normalized = normalizeWordKey(candidate);
    if (normalized && normalized.length >= 3 && !normalized.includes(" ")) {
      candidates.add(normalized);
    }
  };
  if (key.endsWith("ies") && key.length > 4) {
    add(`${key.slice(0, -3)}y`);
  }
  if (key.endsWith("ves") && key.length > 4) {
    add(`${key.slice(0, -3)}f`);
    add(`${key.slice(0, -3)}fe`);
  }
  if (/(?:ches|shes|xes|zes|ses|oes)$/.test(key) && key.length > 4) {
    add(key.slice(0, -2));
  }
  if (key.endsWith("s") && key.length > 4 && !/(?:ss|us|is)$/.test(key)) {
    add(key.slice(0, -1));
  }
  if (key.endsWith("ing") && key.length > 5) {
    const stem = key.slice(0, -3);
    add(stem);
    add(`${stem}e`);
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) {
      add(stem.slice(0, -1));
    }
  }
  if (key.endsWith("ied") && key.length > 4) {
    add(`${key.slice(0, -3)}y`);
  }
  if (key.endsWith("ed") && key.length > 4) {
    const stem = key.slice(0, -2);
    add(stem);
    add(`${stem}e`);
    if (/([b-df-hj-np-tv-z])\1$/.test(stem)) {
      add(stem.slice(0, -1));
    }
  }
  return [...candidates].filter(isMeaningfulEnglishWord);
}

async function fetchOnlineDictionaryMeaningForKey(key: string): Promise<string> {
  const encoded = encodeURIComponent(key);
  const endpoints = [
    { url: `https://api.wiktapi.dev/v1/en/word/${encoded}/translations?lang=ko`, parser: parseOnlineDictionaryMeaning, rootIsTranslations: true },
    { url: `https://api.wiktapi.dev/v1/en/word/${encoded}/translations`, parser: parseOnlineDictionaryMeaning, rootIsTranslations: true },
    { url: `https://freedictionaryapi.com/api/v1/entries/en/${encoded}?translations=true`, parser: parseOnlineDictionaryMeaning, rootIsTranslations: false },
    { url: `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en%7Cko&mt=1`, parser: parseMachineTranslatedKoreanMeaning, rootIsTranslations: false },
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url);
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as unknown;
      const meaning = endpoint.parser(payload, endpoint.rootIsTranslations);
      if (meaning) {
        return meaning;
      }
    } catch {
      continue;
    }
  }
  return "";
}

async function fetchOnlineDictionaryMeaning(term: string): Promise<string> {
  for (const candidate of dictionaryLookupCandidates(term)) {
    const meaning = await fetchOnlineDictionaryMeaningForKey(candidate);
    if (meaning) {
      return meaning;
    }
  }
  return "";
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function proseForTermExtraction(text: string) {
  return text
    .replace(/\$[\s\S]*?\$/g, " ")
    .replace(/\\\([^)]+\\\)|\\\[[^\]]+\\\]/g, " ")
    .replace(/\b[a-z]\s*(?:[=+\-*/^<>]\s*[a-z0-9])+\b/gi, " ")
    .replace(/\b(?:argmax|argmin|cos|exp|lim|log|max|min|sin|sqrt|tan)\b/gi, " ");
}

function termTokens(sentence: string) {
  return [...sentence.matchAll(/[A-Za-z](?:[A-Za-z'-]*[A-Za-z])?/g)]
    .map((match) => {
      const raw = match[0];
      const key = normalizeWordKey(raw);
      return {
        raw,
        key,
        start: match.index ?? 0,
        end: (match.index ?? 0) + raw.length,
        content: isMeaningfulEnglishWord(key),
        connector: isPhraseConnector(key),
        acronym: /^[A-Z]{2,}$/.test(raw),
        capitalized: /^[A-Z][a-z]/.test(raw),
      };
    })
    .filter((token) => token.key.length > 0);
}

function isTechnicalWord(word: string) {
  const key = normalizeWordKey(word);
  return (
    key.length >= 9 ||
    key.includes("-") ||
    technicalSuffixPattern.test(key) ||
    technicalPrefixPattern.test(key)
  );
}

function termCandidateScore(term: string, kind: "word" | "phrase", count: number, examples: string[], titleText: string) {
  const key = normalizeWordKey(term);
  const parts = key.split(" ");
  const inTitle = titleText.includes(key);
  const hasAcronym = examples.some((example) => new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(example) && /\b[A-Z]{2,}\b/.test(example));
  const hasHyphen = key.includes("-");
  const technicalParts = parts.filter((part) => isTechnicalWord(part));
  let score = Math.min(18, count * (kind === "phrase" ? 3 : 1.6));
  if (kind === "phrase") score += 14 + Math.min(8, parts.length * 2);
  if (inTitle) score += 8;
  if (hasAcronym) score += 6;
  if (hasHyphen) score += 4;
  score += Math.min(10, technicalParts.length * 3);
  if (basicDictionaryMeaning(key) && kind === "word") score -= 10;
  const contextNeeded =
    kind === "phrase" ||
    inTitle ||
    hasAcronym ||
    hasHyphen ||
    (kind === "word" && !basicDictionaryMeaning(key) && (technicalParts.length > 0 || key.length >= 8 || (count >= 4 && key.length >= 6)));
  const reason = [
    kind === "phrase" ? "phrase" : "word",
    count > 1 ? `freq:${count}` : "",
    inTitle ? "title" : "",
    hasAcronym ? "acronym" : "",
    hasHyphen ? "hyphen" : "",
    technicalParts.length ? "technical" : "",
    basicDictionaryMeaning(key) && kind === "word" ? "basic-dict" : "",
  ]
    .filter(Boolean)
    .join(",");
  return { score, contextNeeded, reason };
}

function addTermCandidate(
  map: Map<string, { term: string; kind: "word" | "phrase"; count: number; first: number; examples: string[] }>,
  term: string,
  kind: "word" | "phrase",
  first: number,
  example: string,
) {
  const key = normalizeWordKey(term);
  if (!isMeaningfulEnglishTerm(key)) {
    return;
  }
  const existing = map.get(key);
  if (existing) {
    existing.count += 1;
    if (existing.examples.length < 3 && example && !existing.examples.includes(example)) {
      existing.examples.push(example);
    }
    return;
  }
  map.set(key, {
    term: key,
    kind,
    count: 1,
    first,
    examples: example ? [example] : [],
  });
}

function extractDocumentTermCandidates(pages: PageRecord[], document: DocumentRecord | null = null, limit = 5000): DocumentTermCandidate[] {
  const prose = proseForTermExtraction(pages.map((page) => page.text).join("\n\n"));
  const titleText = normalizeForMatch(`${document?.title ?? ""} ${document?.abstractText ?? ""}`);
  const counts = new Map<string, { display: string; count: number; first: number }>();
  for (const match of prose.matchAll(/[A-Za-z](?:[A-Za-z'-]*[A-Za-z])?/g)) {
    const raw = match[0];
    const key = normalizeWordKey(raw);
    if (!isMeaningfulEnglishWord(key)) {
      continue;
    }
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, {
        display: raw,
        count: 1,
        first: match.index ?? 0,
      });
    }
  }
  const candidates = new Map<string, { term: string; kind: "word" | "phrase"; count: number; first: number; examples: string[] }>();
  for (const [word, value] of counts.entries()) {
    addTermCandidate(candidates, word, "word", value.first, "");
  }
  return [...candidates.values()]
    .map((candidate) => {
      const scored = termCandidateScore(candidate.term, candidate.kind, candidate.count, candidate.examples, titleText);
      return {
        term: candidate.term,
        kind: candidate.kind,
        count: candidate.count,
        score: scored.score,
        contextNeeded: scored.contextNeeded,
        reason: scored.reason,
        examples: candidate.examples,
      };
    })
    .filter((candidate) => candidate.kind === "word" || candidate.count > 1 || candidate.score >= 18)
    .sort((a, b) => b.score - a.score || b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, limit);
}

function extractEnglishWordsFromPages(pages: PageRecord[], limit = 5000) {
  return extractDocumentTermCandidates(pages, null, limit).map((candidate) => candidate.term);
}

function parseStoredWordList(settings: Record<string, string>, documentId: string) {
  try {
    const value = settings[documentWordListSettingKey(documentId)];
    const parsed = value ? (JSON.parse(value) as unknown) : [];
    const rows =
      Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { terms?: unknown }).terms)
          ? (parsed as { terms: unknown[] }).terms
          : [];
    return rows.map((word) => normalizeWordKey(String(word))).filter(isMeaningfulEnglishTerm);
  } catch {
    return [];
  }
}

function wordMeaningMapFromSettings(settings: Record<string, string>): WordMeaningMap {
  try {
    const parsed = JSON.parse(settings[wordMeaningMapSettingKey] || "{}") as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const next: WordMeaningMap = {};
    for (const [rawKey, rawEntries] of Object.entries(parsed as Record<string, unknown>)) {
      const key = normalizeWordKey(rawKey);
      if (!key || !Array.isArray(rawEntries)) {
        continue;
      }
      const entries = rawEntries
        .map((entry): WordMeaningEntry | null => {
          if (!entry || typeof entry !== "object") {
            return null;
          }
          const record = entry as Record<string, unknown>;
          const word = normalizeWordKey(String(record.word ?? key));
          const meaning = String(record.meaning ?? "").trim();
          if (!word || !meaning) {
            return null;
          }
          return {
            id: String(record.id ?? makeId("wm")),
            word,
            meaning,
            documentId: String(record.documentId ?? ""),
            documentTitle: String(record.documentTitle ?? ""),
            context: String(record.context ?? ""),
            createdAt: String(record.createdAt ?? nowIso()),
            source: record.source === "local" ? "local" : record.source === "dictionary" ? "dictionary" : "ai",
          };
        })
        .filter((entry): entry is WordMeaningEntry => entry !== null);
      if (entries.length > 0) {
        next[key] = entries;
      }
    }
    return next;
  } catch {
    return {};
  }
}

function parsedWordMeaningFromRecord(record: Record<string, unknown>, fallbackWord = ""): ParsedWordMeaning | null {
  const word = normalizeWordKey(String(record.word ?? record.term ?? record.english ?? fallbackWord));
  const meaning = String(record.meaning ?? record.korean ?? record.translation ?? record.definition ?? "").trim();
  const context = String(record.context ?? record.reason ?? record.note ?? "").trim();
  if (!word || !meaning) {
    return null;
  }
  return { word, meaning, context };
}

function parseWordMeaningItems(outputText: string, fallbackWords: string[] = []): ParsedWordMeaning[] {
  const readable = stripJsonFence(cleanAiOutput(outputText));
  if (!readable) {
    return [];
  }
  const candidates = [readable];
  const jsonMatch = readable.match(/(?:\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch && jsonMatch[0] !== readable) {
    candidates.push(jsonMatch[0]);
  }
  for (const candidate of candidates) {
    try {
      const parsed = parseAiJson(candidate);
      const rows =
        Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === "object" && Array.isArray((parsed as { meanings?: unknown }).meanings)
            ? (parsed as { meanings: unknown[] }).meanings
            : parsed && typeof parsed === "object"
              ? Object.entries(parsed as Record<string, unknown>).map(([word, value]) =>
                  typeof value === "object" && value !== null
                    ? { word, ...(value as Record<string, unknown>) }
                    : { word, meaning: String(value ?? "") },
                )
              : [];
      const parsedRows = rows
        .map((row, index) =>
          row && typeof row === "object"
            ? parsedWordMeaningFromRecord(row as Record<string, unknown>, fallbackWords[index])
            : null,
        )
        .filter((row): row is ParsedWordMeaning => row !== null);
      if (parsedRows.length > 0) {
        return parsedRows;
      }
    } catch {
      continue;
    }
  }
  return readable
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .map((line): ParsedWordMeaning | null => {
      const match = line.match(/^([A-Za-z][A-Za-z' -]{1,90})\s*(?:[:=\-]|->|=>)\s*(.+)$/);
      if (!match) {
        return null;
      }
      return {
        word: normalizeWordKey(match[1]),
        meaning: match[2].trim(),
        context: "",
      };
    })
    .filter((row): row is ParsedWordMeaning => row !== null);
}

function requestedWordMeaningTerms(result: AiResultRecord, fallbackWords: string[]) {
  const terms = new Set(fallbackWords.map(normalizeWordKey).filter(Boolean));
  const match = result.inputText.match(/^\[word meanings:\s*([^\]]+)\]/i);
  if (match) {
    for (const word of match[1].split(",")) {
      const key = normalizeWordKey(word);
      if (key && key !== "...") {
        terms.add(key);
      }
    }
  }
  return terms;
}

function clickedWordFromText(raw: string, ratio: number) {
  const matches = [...raw.matchAll(/[A-Za-z](?:[A-Za-z'-]*[A-Za-z])?/g)];
  if (matches.length === 0) {
    return "";
  }
  const charIndex = Math.max(0, Math.min(raw.length, Math.round(raw.length * ratio)));
  const ranked = matches
    .map((match) => {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      const distance = charIndex >= start && charIndex <= end ? 0 : Math.min(Math.abs(charIndex - start), Math.abs(charIndex - end));
      return { word: match[0], distance };
    })
    .sort((a, b) => a.distance - b.distance);
  const key = normalizeWordKey(ranked[0]?.word ?? "");
  return isMeaningfulEnglishWord(key) ? key : "";
}

function clickedWordFromTextSpan(raw: string, ratio: number, combinedWord = "") {
  const word = clickedWordFromText(raw, ratio);
  const combined = normalizeWordKey(combinedWord);
  if (!word || !combined) {
    return word;
  }
  const trimmed = raw.trim();
  const prefix = normalizeWordKey(trimmed.match(/([A-Za-z][A-Za-z']*)-\s*$/)?.[1] ?? "");
  const suffix = normalizeWordKey(trimmed.match(/^([A-Za-z][A-Za-z']*)/)?.[1] ?? "");
  if ((prefix && word === prefix && combined.startsWith(prefix)) || (suffix && word === suffix && combined.endsWith(suffix))) {
    return combined;
  }
  return word;
}

function annotateHyphenatedTextSpans(layer: HTMLElement) {
  const spans = Array.from(layer.querySelectorAll<HTMLElement>("[data-text]"));
  for (const span of spans) {
    span.dataset.combinedWord = "";
  }
  const orderedSpans = spans.filter((span) => (span.dataset.text ?? "").trim());
  for (let index = 0; index < orderedSpans.length - 1; index += 1) {
    const current = orderedSpans[index];
    const next = orderedSpans[index + 1];
    const prefix = (current.dataset.text ?? "").trim().match(/([A-Za-z][A-Za-z']*)-\s*$/)?.[1] ?? "";
    const suffix = (next.dataset.text ?? "").trim().match(/^([A-Za-z][A-Za-z']*)/)?.[1] ?? "";
    const combined = normalizeWordKey(`${prefix}${suffix}`);
    if (prefix && suffix && isMeaningfulEnglishWord(combined)) {
      current.dataset.combinedWord = combined;
      next.dataset.combinedWord = combined;
    }
  }
}

function bestTermForWordPopup(popup: WordPopup, knownTerms: string[], meaningMap: WordMeaningMap) {
  const word = normalizeWordKey(popup.word);
  if (!word) {
    return "";
  }
  const candidates = dictionaryLookupCandidates(word);
  const known = new Set(knownTerms.map(normalizeWordKey).filter(Boolean));
  for (const candidate of candidates) {
    if (hasUsableWordMeaning(meaningMap[candidate])) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (known.has(candidate)) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (basicDictionaryMeaning(candidate)) {
      return candidate;
    }
  }
  return candidates[0] ?? word;
}

const translationInputMarkerPattern = /^\[translation:\s*([^\]]+)\]\n/i;

function translationInputText(result: AiResultRecord) {
  return result.inputText.replace(translationInputMarkerPattern, "");
}

function translationInputLanguage(result: AiResultRecord) {
  return result.inputText.match(translationInputMarkerPattern)?.[1]?.trim() || "Korean";
}

function translationResultsForPage(
  results: AiResultRecord[],
  page: PageRecord | undefined,
  targetLanguage?: string,
) {
  if (!page?.text) {
    return [];
  }
  return results.filter(
    (result) =>
      result.documentId === page.documentId &&
      result.taskType.toString() === "translatePage" &&
      normalizeComparable(translationInputText(result)) === normalizeComparable(page.text) &&
      (!targetLanguage || translationInputLanguage(result) === targetLanguage),
  );
}

function isLocalQueuedTranslation(result: AiResultRecord) {
  return /translation task queued|a real translation requires/i.test(result.outputText);
}

function translationsForResultUnits(result: AiResultRecord, units: SentenceUnit[]) {
  const lines = parseTranslationLines(getReadableAiOutput(result), units.length);
  const map = parseTranslationMap(result.outputText);
  const translations = new Map<string, string>();
  units.forEach((unit, index) => {
    const translated = (map.get(unit.id) ?? lines[index] ?? "").trim();
    if (translated) {
      translations.set(unit.id, translated);
    }
  });
  return translations;
}

function bestUnitForSource(source: string, units: SentenceUnit[], usedIds: Set<string>) {
  const normalizedSource = normalizeForMatch(source);
  if (!normalizedSource) {
    return null;
  }
  let best: { unit: SentenceUnit; score: number } | null = null;
  for (const unit of units) {
    if (usedIds.has(unit.id)) {
      continue;
    }
    const normalizedUnit = normalizeForMatch(unit.source);
    if (!normalizedUnit) {
      continue;
    }
    const score =
      normalizedSource === normalizedUnit
        ? 4
        : normalizedSource.includes(normalizedUnit)
          ? normalizedUnit.length / Math.max(1, normalizedSource.length)
          : normalizedUnit.includes(normalizedSource)
            ? normalizedSource.length / Math.max(1, normalizedUnit.length)
            : 0;
    if (score > (best?.score ?? 0)) {
      best = { unit, score };
    }
  }
  return best && best.score >= 0.45 ? best.unit : null;
}

function exactUnitsForSource(source: string, units: SentenceUnit[], usedIds: Set<string>) {
  const normalizedSource = normalizeForMatch(source);
  if (!normalizedSource) {
    return [];
  }
  for (let start = 0; start < units.length; start += 1) {
    if (usedIds.has(units[start].id)) {
      continue;
    }
    const matched: SentenceUnit[] = [];
    let combined = "";
    for (let end = start; end < units.length; end += 1) {
      const unit = units[end];
      if (usedIds.has(unit.id)) {
        break;
      }
      matched.push(unit);
      combined = combined ? `${combined} ${unit.source}` : unit.source;
      const normalizedCombined = normalizeForMatch(combined);
      if (normalizedCombined === normalizedSource) {
        return matched;
      }
      if (normalizedCombined.length > normalizedSource.length + 24) {
        break;
      }
    }
  }
  return [];
}

function translationPairUnitsForPage(page: PageRecord | undefined, results: AiResultRecord[], targetLanguage?: string) {
  const sourceUnits = sentenceUnitsForPage(page);
  if (!page) {
    return [];
  }
  const sourceUnitById = new Map(sourceUnits.map((unit) => [unit.id, unit]));
  const completeResults = translationResultsForPage(results, page, targetLanguage)
    .filter((result) => result.status === "complete" && !isLocalQueuedTranslation(result));
  for (const result of completeResults) {
    const pairs = parseTranslationPairs(result.outputText);
    if (pairs.length === 0) {
      continue;
    }
    const usedIds = new Set<string>();
    return pairs
      .map((pair, index) => {
        const ids = pair.sourceIds?.length ? pair.sourceIds : pair.id ? [pair.id] : [];
        const idMatchedUnits = ids
          .map((id) => sourceUnitById.get(id))
          .filter((unit): unit is SentenceUnit => unit !== undefined)
          .filter((unit) => !usedIds.has(unit.id));
        const idMatchedSource = idMatchedUnits.map((unit) => unit.source).join(" ");
        const idMatchIsExact =
          idMatchedUnits.length > 0 &&
          (!pair.source || normalizeForMatch(pair.source) === normalizeForMatch(idMatchedSource));
        const matchedUnits = idMatchIsExact ? idMatchedUnits : exactUnitsForSource(pair.source, sourceUnits, usedIds);
        matchedUnits.forEach((unit) => usedIds.add(unit.id));
        const firstMatched = matchedUnits[0] ?? null;
        return {
          id: firstMatched?.id ?? `p${page.pageNumber}-ai${index}`,
          page: page.pageNumber,
          index,
          source: pair.source || matchedUnits.map((unit) => unit.source).join(" "),
          translation: pair.translation,
          status: "complete" as const,
          aiSegment: true,
          sourceIds: matchedUnits.map((unit) => unit.id),
        };
      })
      .filter((unit) => unit.translation && unit.sourceIds.length > 0);
  }
  return [];
}

function mergedTranslationMapForPage(page: PageRecord | undefined, results: AiResultRecord[], targetLanguage?: string) {
  const units = sentenceUnitsForPage(page);
  const merged = new Map<string, string>();
  if (!page || units.length === 0) {
    return merged;
  }
  const completeResults = translationResultsForPage(results, page, targetLanguage)
    .filter((result) => result.status === "complete" && !isLocalQueuedTranslation(result))
    .reverse();
  for (const result of completeResults) {
    for (const [id, translated] of translationsForResultUnits(result, units)) {
      merged.set(id, translated);
    }
  }
  return merged;
}

function isFullTranslationResultForPage(result: AiResultRecord, page: PageRecord | undefined) {
  const units = sentenceUnitsForPage(page);
  if (units.length === 0 || result.status !== "complete" || isLocalQueuedTranslation(result)) {
    return false;
  }
  const pairUnits = translationPairUnitsForPage(page, [result]);
  if (pairUnits.some((unit) => (unit.sourceIds?.length ?? 0) > 0)) {
    return true;
  }
  const translations = translationsForResultUnits(result, units);
  return units.every((unit) => translations.has(unit.id));
}

function isPageFullyTranslated(page: PageRecord | undefined, results: AiResultRecord[], targetLanguage?: string) {
  const units = sentenceUnitsForPage(page);
  if (!page || units.length === 0) {
    return false;
  }
  if (translationPairUnitsForPage(page, results, targetLanguage).some((unit) => (unit.sourceIds?.length ?? 0) > 0)) {
    return true;
  }
  const translations = mergedTranslationMapForPage(page, results, targetLanguage);
  return units.every((unit) => translations.has(unit.id));
}

function pendingTranslationResultForPage(results: AiResultRecord[], page: PageRecord | undefined, targetLanguage?: string) {
  return (
    translationResultsForPage(results, page, targetLanguage).find(
      (result) => result.status === "pending" && !isStalePendingTranslation(result),
    ) ?? null
  );
}

function hasCompleteTranslationResultForPage(results: AiResultRecord[], page: PageRecord | undefined, targetLanguage?: string) {
  return translationResultsForPage(results, page, targetLanguage).some((result) => result.status === "complete");
}

function translationResultForPage(results: AiResultRecord[], page: PageRecord | undefined, targetLanguage?: string) {
  const matches = translationResultsForPage(results, page, targetLanguage);
  return (
    matches.find((result) => isFullTranslationResultForPage(result, page)) ??
    matches.find((result) => result.status === "pending" && !isStalePendingTranslation(result)) ??
    matches.find((result) => result.status === "complete") ??
    null
  );
}

function translationUnitsForPage(page: PageRecord | undefined, results: AiResultRecord[], targetLanguage?: string): TranslationUnit[] {
  const aiPairUnits = translationPairUnitsForPage(page, results, targetLanguage);
  if (aiPairUnits.length > 0) {
    return aiPairUnits;
  }
  const sourceUnits = sentenceUnitsForPage(page);
  if (!sourceUnits.length) {
    return [];
  }
  const pending = pendingTranslationResultForPage(results, page, targetLanguage);
  const translationMap = mergedTranslationMapForPage(page, results, targetLanguage);
  return sourceUnits.map((unit, index) => ({
    ...unit,
    translation: translationMap.get(unit.id) ?? "",
    status: translationMap.has(unit.id) ? "complete" : pending ? "pending" : "missing",
    sourceIds: [unit.id],
  }));
}

function hasTranslationRequestForPage(results: AiResultRecord[], page: PageRecord | undefined, targetLanguage?: string) {
  return Boolean(pendingTranslationResultForPage(results, page, targetLanguage) || hasCompleteTranslationResultForPage(results, page, targetLanguage));
}

function autoHighlightResultsForPage(results: AiResultRecord[], page: PageRecord | undefined) {
  if (!page) {
    return [];
  }
  const pagePattern = new RegExp(`\\bpage\\s+${page.pageNumber}\\b`, "i");
  return results.filter(
    (result) =>
      result.documentId === page.documentId &&
      result.taskType.toString() === "autoHighlight" &&
      result.status !== "failed" &&
      pagePattern.test(result.inputText),
  );
}

function hasAutoHighlightRequestForPage(results: AiResultRecord[], page: PageRecord | undefined) {
  return autoHighlightResultsForPage(results, page).some(
    (result) => result.status !== "pending" || !isStalePendingTranslation(result),
  );
}

type SharePdfPage = {
  jpegBytes: Uint8Array;
  imageWidth: number;
  imageHeight: number;
  pageWidth: number;
  pageHeight: number;
};

function bytesFromDataUrl(dataUrl: string) {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function loadImageDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load rendered PDF page image."));
    image.src = dataUrl;
  });
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  const tokens = text.replace(/\s+/g, " ").trim().split(/(\s+)/).filter(Boolean);
  let line = "";
  function pushLongToken(token: string) {
    for (const char of Array.from(token)) {
      const candidate = line ? `${line}${char}` : char;
      if (context.measureText(candidate).width > maxWidth && line) {
        lines.push(line.trimEnd());
        line = char;
      } else {
        line = candidate;
      }
    }
  }
  for (const token of tokens.length ? tokens : [text]) {
    if (context.measureText(token).width > maxWidth) {
      pushLongToken(token);
      continue;
    }
    const candidate = line ? `${line}${token}` : token;
    if (context.measureText(candidate).width > maxWidth && line.trim()) {
      lines.push(line.trimEnd());
      line = token.trimStart();
    } else {
      line = candidate;
    }
  }
  if (line.trim()) {
    lines.push(line.trimEnd());
  }
  return lines.length ? lines : [""];
}

function translationEntriesForShare(page: PageRecord, aiResults: AiResultRecord[], targetLanguage?: string, ui: UiStrings = uiStrings.ko) {
  const units = translationUnitsForPage(page, aiResults, targetLanguage);
  if (units.length === 0) {
    return [{ label: "", text: ui.noSentencesOnPage }];
  }
  return units.map((unit) => ({
    label: `${unit.index + 1}.`,
    text: unit.translation || (unit.status === "pending" ? ui.translationQueued : ui.translationMissingSaved),
  }));
}

function measureShareRows(
  context: CanvasRenderingContext2D,
  entries: Array<{ label: string; text: string }>,
  contentWidth: number,
  fontSize: number,
) {
  const labelWidth = 34;
  const lineHeight = Math.max(8, Math.round(fontSize * 1.35));
  const rowGap = fontSize <= 8 ? 2 : fontSize <= 10 ? 4 : 8;
  context.font = `${fontSize}px "Segoe UI", "Malgun Gothic", Arial, sans-serif`;
  const rows = entries.map((entry) => {
    const lines = wrapCanvasText(context, entry.text, contentWidth - labelWidth);
    return {
      ...entry,
      lines,
      height: Math.max(lineHeight, lines.length * lineHeight) + rowGap,
    };
  });
  return {
    rows,
    lineHeight,
    totalHeight: rows.reduce((sum, row) => sum + row.height, 0),
  };
}

function fitShareRows(
  context: CanvasRenderingContext2D,
  entries: Array<{ label: string; text: string }>,
  contentWidth: number,
  contentHeight: number,
) {
  let best = measureShareRows(context, entries, contentWidth, 7);
  for (let fontSize = 16; fontSize >= 7; fontSize -= 1) {
    const measured = measureShareRows(context, entries, contentWidth, fontSize);
    best = measured;
    if (measured.totalHeight <= contentHeight) {
      return { ...measured, fontSize, fits: true };
    }
  }
  return { ...best, fontSize: 7, fits: false };
}

async function renderPdfPageDataUrl(pdf: PdfDocumentProxy, pageNumber: number, scale = 1.45) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is not available.");
  }
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const renderTask = page.render({ canvasContext: context, viewport });
  await renderTask.promise;
  return canvas.toDataURL("image/png");
}

function textBoxesFromPdfItems(
  items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }>,
  viewport: { width: number; height: number; transform: number[] },
  scale: number,
) {
  const util = (pdfjsLib as unknown as { Util: { transform: (a: number[], b: number[]) => number[] } }).Util;
  const boxes: TextLayerBox[] = [];
  for (const item of items) {
    const raw = (item.str ?? "").trim();
    if (!raw) {
      continue;
    }
    const transform = item.transform ? util.transform(viewport.transform, item.transform) : [1, 0, 0, 1, 0, 0];
    const fontHeight = Math.max(8, Math.hypot(transform[2], transform[3]));
    const fallbackWidth = Math.max(8, raw.length * fontHeight * 0.52);
    boxes.push({
      text: raw,
      start: 0,
      end: 0,
      rect: {
        left: transform[4],
        top: transform[5] - fontHeight,
        width: typeof item.width === "number" && item.width > 0 ? item.width * scale : fallbackWidth,
        height: fontHeight * 1.25,
      },
      fontSize: fontHeight,
      fontName: item.fontName ?? "",
    });
  }
  return textAndBoxesFromOrderedLines(textLinesFromBoxes(boxes));
}

function flexibleTextPattern(value: string) {
  return normalizeComparable(value)
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join("\\s+");
}

function previewReferenceNumber(target: PdfLinkPreviewTarget) {
  return (
    target.title.match(/([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/i)?.[1] ??
    target.referenceText?.match(/([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/i)?.[1] ??
    target.targetText?.match(/([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/i)?.[1] ??
    ""
  );
}

function isStatementPreviewKind(kind: ReferencePreviewKind) {
  return kind === "theorem" || kind === "definition" || kind === "remark";
}

function statementLabelsForKind(kind: ReferencePreviewKind) {
  if (kind === "definition") {
    return ["Definition", "Def\\.?"];
  }
  if (kind === "remark") {
    return ["Remark", "Rem\\.?"];
  }
  if (kind === "theorem") {
    return ["Theorem", "Lemma", "Proposition", "Corollary"];
  }
  return [];
}

function statementLabelFromTarget(target: PdfLinkPreviewTarget) {
  const source = target.targetText || target.referenceText || target.title;
  const match = source.match(/\b(Theorem|Lemma|Proposition|Corollary|Definition|Def\.?|Remark|Rem\.?)\b/i);
  return match?.[1] ?? "";
}

function statementLabelPattern(kind: ReferencePreviewKind, preferredLabel = "") {
  const labels = statementLabelsForKind(kind);
  if (labels.length === 0) {
    return "";
  }
  const normalized = preferredLabel.replace(/\.$/, "").toLowerCase();
  const exact =
    normalized === "def"
      ? "(?:Definition|Def\\.?)"
      : normalized === "rem"
        ? "(?:Remark|Rem\\.?)"
        : labels.find((label) => label.replace(/\\\.\?$/, "").toLowerCase() === normalized);
  return exact || labels.join("|");
}

function firstStatementLabelRange(text: string, kind: ReferencePreviewKind, labelNumber: string, preferredLabel = "") {
  if (!isStatementPreviewKind(kind) || !labelNumber) {
    return null;
  }
  const labelPattern = statementLabelPattern(kind, preferredLabel);
  if (!labelPattern) {
    return null;
  }
  const regex = new RegExp(`\\b(?:${labelPattern})\\s*${escapeRegExp(labelNumber)}\\b\\s*[:.(]?`, "i");
  const match = regex.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

function targetRangeForRegionPreview(text: string, target: PdfLinkPreviewTarget) {
  if (isStatementPreviewKind(target.previewKind)) {
    const statementRange = firstStatementLabelRange(
      text,
      target.previewKind,
      previewReferenceNumber(target),
      statementLabelFromTarget(target),
    );
    if (statementRange) {
      return statementRange;
    }
  }

  const exactCandidates = [target.targetText, target.referenceText, target.title].filter(Boolean) as string[];
  for (const candidate of exactCandidates) {
    const pattern = flexibleTextPattern(candidate);
    if (!pattern) {
      continue;
    }
    const match = new RegExp(pattern, "i").exec(text);
    if (match) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }

  const number = previewReferenceNumber(target);
  if (!number) {
    return null;
  }
  const escaped = escapeRegExp(number);
  const patterns =
    target.previewKind === "equation"
      ? [new RegExp(`\\(\\s*${escaped}\\s*\\)`, "i"), new RegExp(`(?:eq\\.?|equation)\\s*\\(?\\s*${escaped}\\s*\\)?`, "i")]
      : target.previewKind === "figure"
        ? [new RegExp(`(?:fig\\.?|figure)\\s*${escaped}`, "i")]
        : target.previewKind === "table"
          ? [new RegExp(`table\\s*${escaped}`, "i")]
          : target.previewKind === "citation"
            ? [new RegExp(`\\[\\s*${escaped}\\s*\\]`, "i"), new RegExp(`(?:^|\\s)${escaped}\\s*[.)]\\s+[A-Z]`, "i")]
            : [new RegExp(escaped, "i")];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}

function cropRectForRegionPreview(
  boxes: TextLayerBox[],
  range: { start: number; end: number },
  kind: ReferencePreviewKind,
  viewportWidth: number,
  viewportHeight: number,
) {
  const matchRect = rectForTextRange(boxes, range.start, range.end);
  if (!matchRect) {
    return null;
  }
  const centerY = matchRect.top + matchRect.height / 2;
  const lineHeight = Math.max(12, matchRect.height);
  const bandTop =
    kind === "citation" || isStatementPreviewKind(kind)
      ? matchRect.top - lineHeight * 0.8
      : matchRect.top - lineHeight * 0.9;
  const bandBottom =
    kind === "citation" || isStatementPreviewKind(kind)
      ? matchRect.top + lineHeight * 3.4
      : kind === "equation"
        ? matchRect.top + lineHeight * 1.9
        : matchRect.top + lineHeight * 2.2;
  const lineTolerance = Math.max(kind === "equation" ? 28 : 20, lineHeight * (kind === "equation" ? 1.8 : 1.4));
  const selected = boxes.filter((box) => {
    const boxCenterY = box.rect.top + box.rect.height / 2;
    if (kind === "equation") {
      return Math.abs(boxCenterY - centerY) <= lineTolerance;
    }
    return boxCenterY >= bandTop && boxCenterY <= bandBottom;
  });
  const basis = selected.length ? selected : boxes.filter((box) => box.end > range.start && box.start < range.end);
  if (!basis.length) {
    return null;
  }
  const left = Math.min(...basis.map((box) => box.rect.left));
  const top = Math.min(...basis.map((box) => box.rect.top));
  const right = Math.max(...basis.map((box) => box.rect.left + box.rect.width));
  const bottom = Math.max(...basis.map((box) => box.rect.top + box.rect.height));
  const padX = kind === "equation" ? 34 : 24;
  const padY = kind === "equation" ? 20 : 18;
  const x = clampNumber(left - padX, 0, viewportWidth);
  const y = clampNumber(top - padY, 0, viewportHeight);
  const width = clampNumber(right - left + padX * 2, 24, viewportWidth - x);
  const height = clampNumber(bottom - top + padY * 2, 24, viewportHeight - y);
  return { x, y, width, height };
}

function isInkPixel(data: Uint8ClampedArray, offset: number) {
  const alpha = data[offset + 3];
  if (alpha < 24) {
    return false;
  }
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  const brightness = (red + green + blue) / 3;
  return brightness < 246 && (red < 242 || green < 242 || blue < 242);
}

function clampCropRect(
  rect: { x: number; y: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
) {
  const x = clampNumber(Math.floor(rect.x), 0, Math.max(0, viewportWidth - 1));
  const y = clampNumber(Math.floor(rect.y), 0, Math.max(0, viewportHeight - 1));
  const width = clampNumber(Math.ceil(rect.width), 1, viewportWidth - x);
  const height = clampNumber(Math.ceil(rect.height), 1, viewportHeight - y);
  return { x, y, width, height };
}

function padCropRect(
  rect: { x: number; y: number; width: number; height: number },
  padX: number,
  padY: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  return clampCropRect(
    {
      x: rect.x - padX,
      y: rect.y - padY,
      width: rect.width + padX * 2,
      height: rect.height + padY * 2,
    },
    viewportWidth,
    viewportHeight,
  );
}

function inkBoundsInRect(
  image: ImageData,
  rect: { x: number; y: number; width: number; height: number },
) {
  const area = clampCropRect(rect, image.width, image.height);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  for (let y = area.y; y < area.y + area.height; y += 1) {
    const rowOffset = y * image.width * 4;
    for (let x = area.x; x < area.x + area.width; x += 1) {
      if (isInkPixel(image.data, rowOffset + x * 4)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function rowInkCounts(
  image: ImageData,
  rect: { x: number; y: number; width: number; height: number },
) {
  const area = clampCropRect(rect, image.width, image.height);
  const counts = new Map<number, number>();
  for (let y = area.y; y < area.y + area.height; y += 1) {
    const rowOffset = y * image.width * 4;
    let count = 0;
    for (let x = area.x; x < area.x + area.width; x += 1) {
      if (isInkPixel(image.data, rowOffset + x * 4)) {
        count += 1;
      }
    }
    counts.set(y, count);
  }
  return counts;
}

function rowBandsFromCounts(
  counts: Map<number, number>,
  yStart: number,
  yEnd: number,
  threshold: number,
  allowedGap: number,
) {
  const bands: Array<{ top: number; bottom: number; peak: number }> = [];
  let current: { top: number; bottom: number; peak: number } | null = null;
  let gap = 0;
  for (let y = yStart; y <= yEnd; y += 1) {
    const count = counts.get(y) ?? 0;
    if (count >= threshold) {
      if (!current) {
        current = { top: y, bottom: y, peak: count };
      } else {
        current.bottom = y;
        current.peak = Math.max(current.peak, count);
      }
      gap = 0;
    } else if (current) {
      gap += 1;
      if (gap > allowedGap) {
        current.bottom = Math.max(current.top, current.bottom - gap);
        bands.push(current);
        current = null;
        gap = 0;
      }
    }
  }
  if (current) {
    current.bottom = Math.max(current.top, current.bottom - gap);
    bands.push(current);
  }
  return bands;
}

function equationVisualCropRect(
  image: ImageData,
  anchorRect: { left: number; top: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
) {
  const centerY = Math.round(anchorRect.top + anchorRect.height / 2);
  const search = Math.max(70, anchorRect.height * 5);
  const yStart = Math.max(0, Math.floor(centerY - search));
  const yEnd = Math.min(image.height - 1, Math.ceil(centerY + search));
  const counts = rowInkCounts(image, { x: 0, y: yStart, width: image.width, height: yEnd - yStart + 1 });
  const threshold = Math.max(3, Math.floor(image.width * 0.0025));
  let seed = centerY;
  let seedScore = -1;
  for (let y = yStart; y <= yEnd; y += 1) {
    const count = counts.get(y) ?? 0;
    if (count < threshold) {
      continue;
    }
    const score = count - Math.abs(y - centerY) * 0.8;
    if (score > seedScore) {
      seed = y;
      seedScore = score;
    }
  }
  if (seedScore < 0) {
    return null;
  }

  const allowedGap = Math.max(10, Math.round(anchorRect.height * 0.9));
  const maxSpan = Math.max(170, anchorRect.height * 9);
  let top = seed;
  let bottom = seed;
  let gap = 0;
  for (let y = seed - 1; y >= Math.max(0, seed - maxSpan); y -= 1) {
    if ((counts.get(y) ?? 0) >= threshold) {
      top = y;
      gap = 0;
    } else {
      gap += 1;
      if (gap > allowedGap) {
        break;
      }
    }
  }
  gap = 0;
  for (let y = seed + 1; y <= Math.min(image.height - 1, seed + maxSpan); y += 1) {
    if ((counts.get(y) ?? 0) >= threshold) {
      bottom = y;
      gap = 0;
    } else {
      gap += 1;
      if (gap > allowedGap) {
        break;
      }
    }
  }

  const bounds = inkBoundsInRect(image, { x: 0, y: top, width: image.width, height: bottom - top + 1 });
  if (!bounds) {
    return null;
  }
  return padCropRect(bounds, 34, 20, viewportWidth, viewportHeight);
}

function textBlockVisualCropRect(
  image: ImageData,
  anchorRect: { left: number; top: number; width: number; height: number },
  kind: ReferencePreviewKind,
  viewportWidth: number,
  viewportHeight: number,
) {
  const line = Math.max(14, anchorRect.height);
  const lines =
    kind === "citation" ? 5 : kind === "algorithm" || isStatementPreviewKind(kind) ? 7 : 3;
  const search = {
    x: 0,
    y: Math.max(0, anchorRect.top - line * 0.8),
    width: viewportWidth,
    height: Math.min(viewportHeight, line * lines),
  };
  const bounds = inkBoundsInRect(image, search);
  return bounds ? padCropRect(bounds, 22, 16, viewportWidth, viewportHeight) : null;
}

function captionObjectVisualCropRect(
  image: ImageData,
  anchorRect: { left: number; top: number; width: number; height: number },
  kind: ReferencePreviewKind,
  viewportWidth: number,
  viewportHeight: number,
) {
  const line = Math.max(14, anchorRect.height);
  const look = Math.min(viewportHeight * 0.72, Math.max(360, line * 34));
  const directions = kind === "table" || kind === "algorithm" ? ["below", "above"] : ["above", "below"];
  const threshold = Math.max(3, Math.floor(viewportWidth * 0.0012));
  const bandGap = Math.max(6, Math.round(line * 0.55));
  const clusterGap =
    kind === "figure"
      ? Math.max(52, Math.round(line * 3.2))
      : Math.max(42, Math.round(line * 2.6));

  for (const direction of directions) {
    const y =
      direction === "above"
        ? Math.max(0, anchorRect.top - look)
        : Math.max(0, anchorRect.top - line * 2.6);
    const bottom =
      direction === "above"
        ? Math.min(viewportHeight, anchorRect.top + line * 6.5)
        : Math.min(viewportHeight, anchorRect.top + look);
    const search = { x: 0, y, width: viewportWidth, height: Math.max(1, bottom - y) };
    const counts = rowInkCounts(image, search);
    const bands = rowBandsFromCounts(
      counts,
      Math.floor(search.y),
      Math.floor(search.y + search.height - 1),
      threshold,
      bandGap,
    );
    if (!bands.length) {
      continue;
    }
    const anchorTop = anchorRect.top - line * 0.7;
    const anchorBottom = anchorRect.top + anchorRect.height + line * 0.9;
    let captionIndex = bands.findIndex((band) => band.bottom >= anchorTop && band.top <= anchorBottom);
    if (captionIndex < 0) {
      const anchorCenter = anchorRect.top + anchorRect.height / 2;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < bands.length; index += 1) {
        const bandCenter = (bands[index].top + bands[index].bottom) / 2;
        const distance = Math.abs(bandCenter - anchorCenter);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          captionIndex = index;
        }
      }
      if (nearestDistance > line * 2.5) {
        continue;
      }
    }

    let top = bands[captionIndex].top;
    let bottomBand = bands[captionIndex].bottom;

    for (let index = captionIndex - 1; index >= 0; index -= 1) {
      const gap = top - bands[index].bottom;
      if (gap > (direction === "above" ? clusterGap : line * 1.8)) {
        break;
      }
      top = bands[index].top;
    }
    for (let index = captionIndex + 1; index < bands.length; index += 1) {
      const gap = bands[index].top - bottomBand;
      if (gap > (direction === "below" ? clusterGap : line * 1.8)) {
        break;
      }
      bottomBand = bands[index].bottom;
    }

    const hasObject =
      direction === "above"
        ? top < anchorRect.top - line * 2
        : bottomBand > anchorRect.top + anchorRect.height + line * 2;
    if (!hasObject) {
      continue;
    }

    const bounds = inkBoundsInRect(image, { x: 0, y: top, width: viewportWidth, height: bottomBand - top + 1 });
    if (bounds && bounds.height > line * 3.2) {
      return padCropRect(bounds, 28, 22, viewportWidth, viewportHeight);
    }
  }
  return textBlockVisualCropRect(image, anchorRect, kind, viewportWidth, viewportHeight);
}

function visualCropRectForRegionPreview(
  image: ImageData,
  boxes: TextLayerBox[],
  range: { start: number; end: number },
  kind: ReferencePreviewKind,
  viewportWidth: number,
  viewportHeight: number,
) {
  const anchorRect = rectForTextRange(boxes, range.start, range.end);
  if (!anchorRect) {
    return null;
  }
  const textRect = cropRectForRegionPreview(boxes, range, kind, viewportWidth, viewportHeight);
  const visualRect =
    kind === "equation"
      ? equationVisualCropRect(image, anchorRect, viewportWidth, viewportHeight)
      : kind === "figure" || kind === "table" || kind === "algorithm"
        ? captionObjectVisualCropRect(image, anchorRect, kind, viewportWidth, viewportHeight)
        : textBlockVisualCropRect(image, anchorRect, kind, viewportWidth, viewportHeight);
  return visualRect ?? textRect;
}

async function renderPdfPageRegionDataUrl(
  pdf: PdfDocumentProxy,
  pageNumber: number,
  target: PdfLinkPreviewTarget,
  scale = 1.85,
) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is not available.");
  }
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const renderTask = page.render({ canvasContext: context, viewport });
  const content = await page.getTextContent();
  const { text, boxes } = textBoxesFromPdfItems(content.items, viewport, scale);
  await renderTask.promise;
  const range = targetRangeForRegionPreview(text, target);
  const pageImage = context.getImageData(0, 0, canvas.width, canvas.height);
  const rect = range
    ? visualCropRectForRegionPreview(pageImage, boxes, range, target.previewKind, viewport.width, viewport.height)
    : null;
  if (!rect) {
    return null;
  }
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = Math.max(1, Math.ceil(rect.width));
  cropCanvas.height = Math.max(1, Math.ceil(rect.height));
  const cropContext = cropCanvas.getContext("2d");
  if (!cropContext) {
    throw new Error("Canvas is not available.");
  }
  cropContext.fillStyle = "#ffffff";
  cropContext.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
  cropContext.drawImage(
    canvas,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    cropCanvas.width,
    cropCanvas.height,
  );
  return cropCanvas.toDataURL("image/png");
}

function hostFromUrl(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return rawUrl.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] || rawUrl;
  }
}

function externalPreviewSummary(url: string, ui: UiStrings = uiStrings.ko) {
  const host = hostFromUrl(url);
  const path = (() => {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`.replace(/^\/$/, "");
    } catch {
      return "";
    }
  })();
  return [
    `${host} ${ui.externalPreviewConnectsTo}`,
    path ? `${ui.externalPreviewPath}: ${path}` : "",
    ui.externalPreviewDescription,
  ]
    .filter(Boolean)
    .join("\n");
}

async function resolvePdfDestinationPage(pdf: PdfDocumentProxy, dest: unknown) {
  let resolved = dest;
  if (typeof resolved === "string" && pdf.getDestination) {
    resolved = await pdf.getDestination(resolved);
  }
  if (!Array.isArray(resolved) || resolved.length === 0) {
    return null;
  }
  const pageRef = resolved[0];
  if (typeof pageRef === "number") {
    return clampNumber(Math.floor(pageRef) + 1, 1, pdf.numPages);
  }
  if (pageRef && pdf.getPageIndex) {
    const pageIndex = await pdf.getPageIndex(pageRef);
    return clampNumber(pageIndex + 1, 1, pdf.numPages);
  }
  return null;
}

async function flattenPdfOutlineRows(pdf: PdfDocumentProxy, items: PdfOutlineItem[], pageCount: number) {
  const rows: OutlineRow[] = [];
  const visit = async (entries: PdfOutlineItem[], depth: number, fallbackPage: number) => {
    let cursorPage = fallbackPage;
    for (const entry of entries) {
      const title = cleanOutlineTitle(entry.title ?? "", "");
      const resolvedPage = entry.dest ? await resolvePdfDestinationPage(pdf, entry.dest).catch(() => null) : null;
      const page = resolvedPage ?? cursorPage;
      if (title) {
        rows.push({
          id: `pdf-outline-${rows.length}-${page}-${outlineDomToken(title).slice(0, 36)}`,
          page: clampNumber(page, 1, Math.max(1, pageCount || pdf.numPages)),
          title,
          level: clampNumber(depth, 0, 3),
          source: "pdf",
        });
      }
      cursorPage = resolvedPage ?? cursorPage;
      if (entry.items?.length) {
        await visit(entry.items, depth + 1, cursorPage);
      }
      if (rows.length >= 60) {
        break;
      }
    }
  };
  await visit(items, 0, 1);
  return rows;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snippetAround(text: string, index: number, limit = 220) {
  const source = normalizeComparable(text);
  if (!source) {
    return "";
  }
  const start = clampNumber(index - Math.floor(limit / 2), 0, Math.max(0, source.length - 1));
  const end = clampNumber(start + limit, 0, source.length);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < source.length ? "..." : "";
  return `${prefix}${source.slice(start, end).trim()}${suffix}`;
}

function referenceSectionStartPage(pages: PageRecord[]) {
  return (
    pages.find((page) => /\b(references|bibliography|works cited|literature cited)\b/i.test(page.text))?.pageNumber ??
    null
  );
}

type ReferenceTargetPattern = {
  regex: RegExp;
  score: number;
  preferReferences?: boolean;
  preferMath?: boolean;
};

function regexWithGlobal(pattern: RegExp) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

function isRegionPreviewKind(kind: ReferencePreviewKind) {
  return ["citation", "equation", "figure", "table", "algorithm", "theorem", "definition", "remark"].includes(kind);
}

function findReferenceTargetByPatterns(
  pages: PageRecord[],
  sourcePage: number,
  patterns: ReferenceTargetPattern[],
) {
  const referenceStart = referenceSectionStartPage(pages);
  let best: { page: number; excerpt: string; score: number; targetText: string } | null = null;
  for (const page of pages) {
    const text = normalizeComparable(page.text);
    if (!text) {
      continue;
    }
    for (const pattern of patterns) {
      const regex = regexWithGlobal(pattern.regex);
      for (let match = regex.exec(text); match; match = regex.exec(text)) {
        const index = match.index ?? 0;
        const windowText = text.slice(Math.max(0, index - 100), Math.min(text.length, index + 140));
        let score = pattern.score;
        if (pattern.preferReferences && referenceStart !== null && page.pageNumber >= referenceStart) {
          score += 12;
        }
        if (pattern.preferMath && /[=+\-*/^_{}<>]|\\sum|\\int|\\prod|\\lim/i.test(windowText)) {
          score += 10;
        }
        if (/[.:]\s+[A-Z0-9]/.test(windowText.slice(Math.max(0, match[0].length - 3), match[0].length + 8))) {
          score += 2;
        }
        score += Math.max(0, 5 - Math.abs(page.pageNumber - sourcePage)) * 0.15;
        if (page.pageNumber === sourcePage && pages.length > 1) {
          score -= 0.75;
        }
        if (!best || score > best.score) {
          best = { page: page.pageNumber, excerpt: snippetAround(text, index), score, targetText: match[0] };
        }
        if (match[0].length === 0) {
          regex.lastIndex += 1;
        }
      }
    }
  }
  return best;
}

function citationNumberTarget(pages: PageRecord[], sourcePage: number, marker: string) {
  const number = marker.match(/\d+/)?.[0];
  if (!number) {
    return null;
  }
  const escaped = escapeRegExp(number);
  return findReferenceTargetByPatterns(pages, sourcePage, [
    { regex: new RegExp(`\\[\\s*${escaped}\\s*\\]`, "i"), score: 8, preferReferences: true },
    { regex: new RegExp(`(?:^|\\s)${escaped}\\s*[.)]\\s+[A-Z]`, "i"), score: 4, preferReferences: true },
  ]);
}

function authorYearTarget(pages: PageRecord[], sourcePage: number, surname: string, year: string) {
  const cleanSurname = surname.replace(/[^A-Za-z'-]/g, "");
  const cleanYear = year.match(/\d{4}/)?.[0] ?? "";
  if (cleanSurname.length < 2 || !cleanYear) {
    return null;
  }
  return findReferenceTargetByPatterns(pages, sourcePage, [
    {
      regex: new RegExp(`${escapeRegExp(cleanSurname)}.{0,180}${escapeRegExp(cleanYear)}`, "i"),
      score: 7,
      preferReferences: true,
    },
    {
      regex: new RegExp(`${escapeRegExp(cleanYear)}.{0,180}${escapeRegExp(cleanSurname)}`, "i"),
      score: 4,
      preferReferences: true,
    },
  ]);
}

function firstStatementTarget(
  pages: PageRecord[],
  kind: ReferencePreviewKind,
  labelNumber: string,
  preferredLabel = "",
) {
  if (!isStatementPreviewKind(kind)) {
    return null;
  }
  const orderedPages = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  for (const page of orderedPages) {
    const text = normalizeComparable(page.text);
    const range = firstStatementLabelRange(text, kind, labelNumber, preferredLabel);
    if (!range) {
      continue;
    }
    const targetText = text.slice(range.start, range.end).trim();
    return {
      page: page.pageNumber,
      excerpt: snippetAround(text, range.start),
      score: 30,
      targetText,
    };
  }
  return null;
}

function labeledReferenceTarget(
  pages: PageRecord[],
  sourcePage: number,
  kind: ReferencePreviewKind,
  labelNumber: string,
  preferredLabel = "",
) {
  const escaped = escapeRegExp(labelNumber);
  if (kind === "page") {
    const page = Number(labelNumber);
    return page >= 1 && page <= pages.length
      ? {
          page,
          excerpt: pages.find((item) => item.pageNumber === page)?.outlineLabel || `Page ${page}`,
          score: 20,
          targetText: `Page ${page}`,
        }
      : null;
  }
  if (kind === "equation") {
    return findReferenceTargetByPatterns(pages, sourcePage, [
      { regex: new RegExp(`\\(\\s*${escaped}\\s*\\)`, "i"), score: 6, preferMath: true },
      { regex: new RegExp(`(?:eq\\.?|equation)\\s*\\(?\\s*${escaped}\\s*\\)?`, "i"), score: 4, preferMath: true },
    ]);
  }
  if (kind === "section") {
    return findReferenceTargetByPatterns(pages, sourcePage, [
      { regex: new RegExp(`(?:^|\\s)${escaped}\\s+[A-Z][A-Za-z]`, "i"), score: 9 },
      { regex: new RegExp(`(?:sec\\.?|section|appendix)\\s*${escaped}`, "i"), score: 5 },
    ]);
  }
  const statementTarget = firstStatementTarget(pages, kind, labelNumber, preferredLabel);
  if (statementTarget) {
    return statementTarget;
  }
  const labels: Record<string, string[]> = {
    figure: ["fig\\.?", "figure"],
    table: ["table"],
    algorithm: ["alg\\.?", "algorithm"],
    theorem: ["theorem", "lemma", "proposition", "corollary"],
    definition: ["definition", "def\\.?"],
    remark: ["remark", "rem\\.?"],
    link: [],
    citation: [],
    equation: [],
    section: [],
    page: [],
  };
  const labelAlternatives = labels[kind] ?? [];
  if (labelAlternatives.length === 0) {
    return null;
  }
  const label = `(?:${labelAlternatives.join("|")})`;
  return findReferenceTargetByPatterns(pages, sourcePage, [
    { regex: new RegExp(`${label}\\s*${escaped}\\s*[:.(]`, "i"), score: 14 },
    { regex: new RegExp(`${label}\\s*${escaped}`, "i"), score: 5 },
  ]);
}

function rectForTextRange(boxes: TextLayerBox[], start: number, end: number) {
  const selected = boxes
    .filter((box) => box.end > start && box.start < end)
    .map((box) => {
      const length = Math.max(1, box.end - box.start);
      const startRatio = clampNumber((Math.max(start, box.start) - box.start) / length, 0, 1);
      const endRatio = clampNumber((Math.min(end, box.end) - box.start) / length, startRatio, 1);
      const left = box.rect.left + box.rect.width * startRatio;
      const width = Math.max(2, box.rect.width * (endRatio - startRatio));
      return {
        rect: {
          left,
          top: box.rect.top,
          width,
          height: box.rect.height,
        },
      };
    });
  if (selected.length === 0) {
    return null;
  }
  const left = Math.min(...selected.map((box) => box.rect.left));
  const top = Math.min(...selected.map((box) => box.rect.top));
  const right = Math.max(...selected.map((box) => box.rect.left + box.rect.width));
  const bottom = Math.max(...selected.map((box) => box.rect.top + box.rect.height));
  const width = right - left;
  const height = bottom - top;
  return width > 2 && height > 2 ? { left, top, width, height } : null;
}

function referencePreviewTargetsForPage(
  sourcePage: number,
  text: string,
  boxes: TextLayerBox[],
  pages: PageRecord[],
) {
  if (!text || boxes.length === 0 || pages.length === 0) {
    return [];
  }
  const targets: PdfLinkPreviewTarget[] = [];
  const targetRanges: Array<{ start: number; end: number }> = [];
  const addTarget = (
    match: RegExpExecArray,
    kind: ReferencePreviewKind,
    title: string,
    target: { page: number; excerpt: string; targetText?: string } | null,
  ) => {
    if (!target) {
      return;
    }
    const start = match.index;
    const end = start + match[0].length;
    if (targetRanges.some((range) => Math.max(start, range.start) < Math.min(end, range.end))) {
      return;
    }
    const rect = rectForTextRange(boxes, start, end);
    if (!rect) {
      return;
    }
    targets.push({
      id: `${sourcePage}:${kind}:${targets.length}:${start}:${end}`,
      sourcePage,
      title,
      kind: "internal",
      previewKind: kind,
      rect,
      targetPage: target.page,
      targetText: target.targetText,
      excerpt: target.excerpt,
      referenceText: match[0],
    });
    targetRanges.push({ start, end });
  };

  const labelPatterns: Array<{
    regex: RegExp;
    kind: ReferencePreviewKind;
    title: (match: RegExpExecArray) => string;
    valueIndex?: number;
    labelIndex?: number;
  }> = [
    { regex: /\b(?:Eq\.?|Equation)\s*\(?\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)\s*\)?/gi, kind: "equation", title: (match) => `Equation (${match[1]})` },
    { regex: /\b(?:Fig\.?|Figure)\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/gi, kind: "figure", title: (match) => `Figure ${match[1]}` },
    { regex: /\bTable\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/gi, kind: "table", title: (match) => `Table ${match[1]}` },
    { regex: /\b(?:Alg\.?|Algorithm)\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/gi, kind: "algorithm", title: (match) => `Algorithm ${match[1]}` },
    {
      regex: /\b(Theorem|Lemma|Proposition|Corollary)\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/gi,
      kind: "theorem",
      title: (match) => `${match[1]} ${match[2]}`,
      valueIndex: 2,
      labelIndex: 1,
    },
    {
      regex: /\b(Def\.?|Definition)\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/gi,
      kind: "definition",
      title: (match) => `${/^def\.?$/i.test(match[1]) ? "Definition" : match[1]} ${match[2]}`,
      valueIndex: 2,
      labelIndex: 1,
    },
    {
      regex: /\b(Rem\.?|Remark)\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/gi,
      kind: "remark",
      title: (match) => `${/^rem\.?$/i.test(match[1]) ? "Remark" : match[1]} ${match[2]}`,
      valueIndex: 2,
      labelIndex: 1,
    },
    { regex: /\b(?:Sec\.?|Section|Appendix)\s*([A-Za-z]?\d+(?:\.\d+){0,3}[a-z]?)/gi, kind: "section", title: (match) => `Section ${match[1]}` },
    { regex: /\b(?:page|p\.)\s*(\d{1,4})\b/gi, kind: "page", title: (match) => `Page ${match[1]}` },
  ];

  for (const pattern of labelPatterns) {
    for (let match = pattern.regex.exec(text); match && targets.length < 48; match = pattern.regex.exec(text)) {
      const labelNumber = match[pattern.valueIndex ?? 1];
      addTarget(
        match,
        pattern.kind,
        pattern.title(match),
        labeledReferenceTarget(pages, sourcePage, pattern.kind, labelNumber, pattern.labelIndex ? match[pattern.labelIndex] : ""),
      );
    }
  }

  return targets;
}

async function createTranslatedSharePage(
  pageImageDataUrl: string,
  page: PageRecord,
  aiResults: AiResultRecord[],
  targetLanguage?: string,
  ui: UiStrings = uiStrings.ko,
): Promise<SharePdfPage> {
  const pageImage = await loadImageDataUrl(pageImageDataUrl);
  const entries = translationEntriesForShare(page, aiResults, targetLanguage, ui);
  const probeCanvas = document.createElement("canvas");
  const probeContext = probeCanvas.getContext("2d");
  if (!probeContext) {
    throw new Error("Canvas is not available.");
  }

  const sideWidthCandidates = [
    Math.max(960, Math.round(pageImage.width * 1.35)),
    Math.max(1280, Math.round(pageImage.width * 1.75)),
    Math.max(1700, Math.round(pageImage.width * 2.25)),
    Math.max(2200, Math.round(pageImage.width * 3)),
  ];
  let sideWidth = sideWidthCandidates[0];
  let margin = Math.max(28, Math.round(sideWidth * 0.045));
  let contentWidth = sideWidth - margin * 2;
  let contentTop = margin + 52;
  let fitted = fitShareRows(probeContext, entries, contentWidth, pageImage.height - contentTop - margin);
  for (const candidate of sideWidthCandidates) {
    const candidateMargin = Math.max(28, Math.round(candidate * 0.045));
    const candidateContentWidth = candidate - candidateMargin * 2;
    const candidateContentTop = candidateMargin + 52;
    const candidateFitted = fitShareRows(
      probeContext,
      entries,
      candidateContentWidth,
      pageImage.height - candidateContentTop - candidateMargin,
    );
    sideWidth = candidate;
    margin = candidateMargin;
    contentWidth = candidateContentWidth;
    contentTop = candidateContentTop;
    fitted = candidateFitted;
    if (candidateFitted.fits) {
      break;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = pageImage.width + sideWidth;
  canvas.height = pageImage.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is not available.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(pageImage, 0, 0);

  const sidebarX = pageImage.width;
  context.fillStyle = "#fbfcfb";
  context.fillRect(sidebarX, 0, sideWidth, canvas.height);
  context.strokeStyle = "#d7e0dd";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(sidebarX + 1, 0);
  context.lineTo(sidebarX + 1, canvas.height);
  context.stroke();

  const titleTop = margin;
  context.fillStyle = "#202427";
  context.font = `700 ${Math.max(22, Math.round(canvas.height / 46))}px "Segoe UI", "Malgun Gothic", Arial, sans-serif`;
  context.fillText(`${ui.page} ${page.pageNumber} ${ui.translationPanel}`, sidebarX + margin, titleTop + 4);
  const labelWidth = 34;
  let y = contentTop;
  context.font = `${fitted.fontSize}px "Segoe UI", "Malgun Gothic", Arial, sans-serif`;
  for (const row of fitted.rows) {
    if (y > canvas.height - margin) {
      break;
    }
    context.fillStyle = "#8b8f8d";
    context.font = `700 ${fitted.fontSize}px "Segoe UI", "Malgun Gothic", Arial, sans-serif`;
    context.fillText(row.label, sidebarX + margin, y + fitted.lineHeight);
    context.fillStyle = "#202427";
    context.font = `${fitted.fontSize}px "Segoe UI", "Malgun Gothic", Arial, sans-serif`;
    row.lines.forEach((line, index) => {
      context.fillText(line, sidebarX + margin + labelWidth, y + fitted.lineHeight * (index + 1));
    });
    y += row.height;
  }
  if (!fitted.fits) {
    context.fillStyle = "#c65f4a";
    context.font = `700 ${Math.max(10, fitted.fontSize)}px "Segoe UI", "Malgun Gothic", Arial, sans-serif`;
    context.fillText(ui.shareTruncated, sidebarX + margin, canvas.height - margin / 2);
  }

  const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.92);
  return {
    jpegBytes: bytesFromDataUrl(jpegDataUrl),
    imageWidth: canvas.width,
    imageHeight: canvas.height,
    pageWidth: Math.round(canvas.width * 0.75 * 100) / 100,
    pageHeight: Math.round(canvas.height * 0.75 * 100) / 100,
  };
}

function concatBytes(parts: Uint8Array[]) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function buildPdfFromJpegPages(pages: SharePdfPage[]) {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let byteLength = 0;
  let objectNumber = 1;
  const add = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    byteLength += bytes.length;
  };
  const addObject = (parts: Array<string | Uint8Array>) => {
    const number = objectNumber;
    objectNumber += 1;
    offsets[number] = byteLength;
    add(`${number} 0 obj\n`);
    parts.forEach(add);
    add("\nendobj\n");
    return number;
  };

  add("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");
  const pageObjectNumbers = pages.map((_, index) => 3 + index * 3);
  addObject(["<< /Type /Catalog /Pages 2 0 R >>"]);
  addObject([`<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pages.length} >>`]);
  pages.forEach((page, index) => {
    const pageObject = 3 + index * 3;
    const imageObject = pageObject + 1;
    const contentObject = pageObject + 2;
    const imageName = `/Im${index + 1}`;
    const content = `q\n${page.pageWidth} 0 0 ${page.pageHeight} 0 0 cm\n${imageName} Do\nQ\n`;
    addObject([
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.pageWidth} ${page.pageHeight}] /Resources << /XObject << ${imageName} ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`,
    ]);
    addObject([
      `<< /Type /XObject /Subtype /Image /Width ${page.imageWidth} /Height ${page.imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.length} >>\nstream\n`,
      page.jpegBytes,
      "\nendstream",
    ]);
    addObject([`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`]);
  });
  const xrefOffset = byteLength;
  add(`xref\n0 ${objectNumber}\n0000000000 65535 f \n`);
  for (let index = 1; index < objectNumber; index += 1) {
    add(`${String(offsets[index] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  add(`trailer\n<< /Size ${objectNumber} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return concatBytes(chunks);
}

function isStalePendingTranslation(result: AiResultRecord) {
  if (result.taskType.toString() !== "translatePage" || result.status !== "pending") {
    return false;
  }
  const createdAt = Date.parse(result.createdAt);
  return Number.isFinite(createdAt) && Date.now() - createdAt > stalePendingTranslationMs;
}

function hasBlockingPendingTranslation(results: AiResultRecord[]) {
  const completedInputs = new Set(
    results
      .filter((result) => result.taskType.toString() === "translatePage" && result.status === "complete")
      .map((result) => normalizeComparable(result.inputText)),
  );
  return results.some(
    (result) =>
      result.taskType.toString() === "translatePage" &&
      result.status === "pending" &&
      !isStalePendingTranslation(result) &&
      !completedInputs.has(normalizeComparable(result.inputText)),
  );
}

function translationRequestKey(documentId: string, pageNumber: number, text: string, targetLanguage = "Korean") {
  return `${documentId}:${pageNumber}:${targetLanguage}:${normalizeComparable(text).slice(0, 160)}`;
}

function autoHighlightRequestKey(documentId: string, pageNumber: number, text: string) {
  return `${documentId}:${pageNumber}:${normalizeComparable(text).slice(0, 160)}`;
}

function sentenceBounds(text: string, units: SentenceUnit[]) {
  let cursor = 0;
  return units.map((unit) => {
    const index = text.indexOf(unit.source, cursor);
    const start = index >= 0 ? index : cursor;
    const end = start + unit.source.length;
    cursor = end;
    return { id: unit.id, start, end };
  });
}

function annotationKey(annotation: AnnotationRecord) {
  return `${annotation.page}:${annotation.tag}:${normalizeForMatch(annotation.rangeHint || annotation.text).slice(0, 100)}`;
}

function isExplanationAnnotation(annotation: AnnotationRecord) {
  return annotation.tag === explanationTag;
}

function explanationResultId(annotation: AnnotationRecord) {
  return annotation.comment.startsWith("ai:") ? annotation.comment.slice(3) : "";
}

type FolderTreeRow = {
  folder: FolderRecord;
  depth: number;
  documentCount: number;
  totalDocumentCount: number;
  childCount: number;
};

function documentFolderId(document: DocumentRecord) {
  return document.folderId || "root";
}

function folderDisplayName(folder: FolderRecord, ui: UiStrings = uiStrings.ko) {
  return folder.id === "root" ? ui.libraryRoot : folder.name;
}

function sortedFolderChildren(folders: FolderRecord[], parentId: string | null) {
  return folders
    .filter((folder) => (folder.parentId ?? null) === parentId)
    .sort((a, b) => {
      if (a.id === "root") return -1;
      if (b.id === "root") return 1;
      return folderDisplayName(a).localeCompare(folderDisplayName(b), undefined, { sensitivity: "base" });
    });
}

function folderDescendantIds(folders: FolderRecord[], folderId: string) {
  const ids = new Set<string>([folderId]);
  const visit = (parentId: string) => {
    for (const child of folders.filter((folder) => folder.parentId === parentId)) {
      if (!ids.has(child.id)) {
        ids.add(child.id);
        visit(child.id);
      }
    }
  };
  visit(folderId);
  return ids;
}

function folderTreeRows(folders: FolderRecord[], documents: DocumentRecord[]) {
  const directCounts = new Map<string, number>();
  for (const document of documents) {
    const folderId = documentFolderId(document);
    directCounts.set(folderId, (directCounts.get(folderId) ?? 0) + 1);
  }

  const rows: FolderTreeRow[] = [];
  const seen = new Set<string>();
  const pushRows = (parentId: string | null, depth: number) => {
    for (const folder of sortedFolderChildren(folders, parentId)) {
      if (seen.has(folder.id)) {
        continue;
      }
      seen.add(folder.id);
      const descendants = folderDescendantIds(folders, folder.id);
      rows.push({
        folder,
        depth,
        documentCount: directCounts.get(folder.id) ?? 0,
        totalDocumentCount: documents.filter((document) => descendants.has(documentFolderId(document))).length,
        childCount: folders.filter((child) => child.parentId === folder.id).length,
      });
      pushRows(folder.id, depth + 1);
    }
  };

  pushRows(null, 0);
  for (const folder of folders) {
    if (!seen.has(folder.id)) {
      rows.push({
        folder,
        depth: 0,
        documentCount: directCounts.get(folder.id) ?? 0,
        totalDocumentCount: documents.filter((document) => folderDescendantIds(folders, folder.id).has(documentFolderId(document))).length,
        childCount: folders.filter((child) => child.parentId === folder.id).length,
      });
    }
  }
  return rows;
}

function folderPathLabel(folders: FolderRecord[], folderId: string | null, ui: UiStrings = uiStrings.ko) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const parts: string[] = [];
  const seen = new Set<string>();
  let cursor = folderId || "root";
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = byId.get(cursor);
    if (!folder) {
      break;
    }
    parts.unshift(folderDisplayName(folder, ui));
    cursor = folder.parentId || "";
  }
  return parts.length ? parts.join(" / ") : ui.libraryRoot;
}

function isUnsafeGeneratedHref(rawHref: string | null | undefined) {
  const href = (rawHref ?? "").trim();
  const lower = href.toLowerCase();
  return (
    lower.startsWith("#type=click") ||
    lower.includes("#type=click&tag=") ||
    lower.includes("openai.codex_") ||
    lower.startsWith("app:") ||
    lower.startsWith("file:") ||
    /^[a-z]:[\\/]/i.test(href)
  );
}

function App() {
  const [state, setState] = useState<AppStateRecord>(initialState);
  const [mode, setMode] = useState<WorkspaceMode>("library");
  const [activePanel, setActivePanel] = useState<PanelTab>("ai");
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PdfDocumentProxy | null>(null);
  const [loadedBytes, setLoadedBytes] = useState<Uint8Array | null>(null);
  const [pageImages, setPageImages] = useState<Record<number, string>>({});
  const [zoom, setZoom] = useState(defaultReaderZoom);
  const [pageCursor, setPageCursor] = useState(1);
  const [searchTerm, setSearchTerm] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState("root");
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbar | null>(null);
  const [wordPopup, setWordPopup] = useState<WordPopup | null>(null);
  const [wordLookupLoadingKey, setWordLookupLoadingKey] = useState<string | null>(null);
  const [hoverSource, setHoverSource] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [outlineCompact, setOutlineCompact] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [markupTool, setMarkupTool] = useState<ReaderMarkupTool>({ kind: "none" });
  const [assistantMode, setAssistantMode] = useState<ReaderAssistantMode>("study");
  const [floatingResultId, setFloatingResultId] = useState<string | null>(null);
  const [linkPreview, setLinkPreview] = useState<LinkPreviewState | null>(null);
  const [linkPreviewLoading, setLinkPreviewLoading] = useState(false);
  const [selectedSentenceId, setSelectedSentenceId] = useState<string | null>(null);
  const [translationEligiblePages, setTranslationEligiblePages] = useState<Set<number>>(() => new Set([1]));
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [translationPanelOpen, setTranslationPanelOpen] = useState(false);
  const [layoutOverride, setLayoutOverride] = useState<Partial<Record<LayoutPane, number>>>({});
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Partial<Record<AiProviderKind, AgentProviderStatus>>>({});
  const [isBusy, setIsBusy] = useState(false);
  const [pdfOutlineRows, setPdfOutlineRows] = useState<OutlineRow[]>([]);
  const [pageOutlineAnchors, setPageOutlineAnchors] = useState<Record<number, OutlineAnchor[]>>({});
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
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
  const readerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const scrollSaveTimerRef = useRef<number | null>(null);
  const readerScrollSyncFrameRef = useRef<number | null>(null);
  const translationRequestsRef = useRef<Map<string, number>>(new Map());
  const autoHighlightRequestsRef = useRef<Map<string, number>>(new Map());
  const incompleteTranslationRetriesRef = useRef<Map<string, number>>(new Map());
  const outlineRequestsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const blockUnsafeGeneratedNavigation = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) {
        return;
      }
      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!link) {
        return;
      }
      if (isUnsafeGeneratedHref(link.getAttribute("href")) || isUnsafeGeneratedHref(link.href)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("click", blockUnsafeGeneratedNavigation, true);
    return () => document.removeEventListener("click", blockUnsafeGeneratedNavigation, true);
  }, []);

  const activeDocument = useMemo(
    () => state.documents.find((document) => document.id === activeDocumentId) ?? null,
    [activeDocumentId, state.documents],
  );
  const activePages = useMemo(
    () => (activeDocument ? documentPages(state, activeDocument.id) : []),
    [activeDocument, state],
  );
  const currentPage = useMemo(
    () => activePages.find((page) => page.pageNumber === pageCursor),
    [activePages, pageCursor],
  );
  const wordMeaningMap = useMemo(() => wordMeaningMapFromSettings(state.settings), [state.settings]);
  const activeDocumentWordList = useMemo(() => {
    if (!activeDocument) {
      return [];
    }
    const stored = parseStoredWordList(state.settings, activeDocument.id);
    return stored.length ? stored : extractDocumentTermCandidates(activePages, activeDocument).map((candidate) => candidate.term);
  }, [activeDocument, activePages, state.settings]);
  const missingWordCount = useMemo(
    () => activeDocumentWordList.filter((word) => !wordMeaningMap[normalizeWordKey(word)]?.length).length,
    [activeDocumentWordList, wordMeaningMap],
  );
  const activeAnnotations = useMemo(
    () => state.annotations.filter((item) => item.documentId === activeDocumentId),
    [activeDocumentId, state.annotations],
  );
  const activeAiResults = useMemo(
    () => state.aiResults.filter((item) => item.documentId === activeDocumentId),
    [activeDocumentId, state.aiResults],
  );
  const activeDetectedOutlineAnchors = useMemo(
    () =>
      Object.values(pageOutlineAnchors)
        .flat()
        .sort((a, b) => a.page - b.page || a.top - b.top),
    [pageOutlineAnchors],
  );
  const uiLanguage = uiLanguageFromSettings(state.settings);
  const ui = uiStrings[uiLanguage];
  const translationLanguageName = translationLanguageNameFromSettings(state.settings);
  const currentTranslationUnits = useMemo(
    () => translationUnitsForPage(currentPage, activeAiResults, translationLanguageName),
    [activeAiResults, currentPage, translationLanguageName],
  );
  const selectedSentenceIds = useMemo(() => {
    if (!selectedSentenceId) {
      return [];
    }
    const selectedUnit = currentTranslationUnits.find(
      (unit) => unit.id === selectedSentenceId || (unit.sourceIds ?? []).includes(selectedSentenceId),
    );
    return selectedUnit?.sourceIds?.length ? selectedUnit.sourceIds : [selectedSentenceId];
  }, [currentTranslationUnits, selectedSentenceId]);
  const activeOutlineRows = useMemo(
    () => readerOutlineRows(activeAiResults, pdfOutlineRows, activePages, activeDetectedOutlineAnchors, ui),
    [activeAiResults, pdfOutlineRows, activePages, activeDetectedOutlineAnchors, ui],
  );
  const activeCitations = useMemo(
    () => state.citationCards.filter((item) => item.documentId === activeDocumentId),
    [activeDocumentId, state.citationCards],
  );
  const activeNote = useMemo(
    () => (activeDocument ? currentNote(state, activeDocument.id) : null),
    [activeDocument, state],
  );
  const floatingResult = useMemo(
    () => activeAiResults.find((result) => result.id === floatingResultId) ?? null,
    [activeAiResults, floatingResultId],
  );
  useEffect(() => {
    const existing = new Set(state.documents.map((document) => document.id));
    setSelectedDocumentIds((current) => current.filter((id) => existing.has(id)));
  }, [state.documents]);
  const bridgePath = state.settings.bridgePath || "bridge";
  const savedHorizontalScrollLeft = horizontalScrollFromSettings(state.settings, activeDocumentId);
  const savedLayout = useMemo(
    () => ({
      outline: settingsNumber(
        state.settings,
        layoutBounds.outline.setting,
        layoutDefaults.outline,
        layoutBounds.outline.min,
        layoutBounds.outline.max,
      ),
      translation: settingsNumber(
        state.settings,
        layoutBounds.translation.setting,
        layoutDefaults.translation,
        layoutBounds.translation.min,
        layoutBounds.translation.max,
      ),
      rightPanel: settingsNumber(
        state.settings,
        layoutBounds.rightPanel.setting,
        layoutDefaults.rightPanel,
        layoutBounds.rightPanel.min,
        layoutBounds.rightPanel.max,
      ),
    }),
    [state.settings],
  );
  const readerLayout = useMemo(
    () => ({
      ...savedLayout,
      ...layoutOverride,
    }),
    [layoutOverride, savedLayout],
  );
  const readerGridStyle = useMemo(
    () =>
      ({
        "--outline-width": `${readerLayout.outline}px`,
        "--translation-width": `${readerLayout.translation}px`,
        "--right-panel-width": `${readerLayout.rightPanel}px`,
      }) as CSSProperties,
    [readerLayout],
  );
  useEffect(() => {
    let mounted = true;
    loadAppState()
      .then((loaded) => {
        if (!mounted) {
          return;
        }
        const settings = { ...initialState.settings, ...loaded.settings };
        settings.uiLanguage = settings.uiLanguage === "en" ? "en" : "ko";
        settings.language = settings.uiLanguage;
        settings.translationLanguage = translationLanguageOption(settings.translationLanguage).value;
        const normalizedProvider = normalizeAiProviderKind(settings.aiProvider);
        settings.codexModel = settings.codexModel || (normalizedProvider === "codex-cli" ? settings.aiModel || "" : "");
        settings.codexReasoningEffort = selectedCodexReasoningEffort(settings);
        settings.claudeModel = settings.claudeModel || (normalizedProvider === "claude-code" ? settings.aiModel || "" : "");
        settings.autoHighlight = "false";
        settings.wordMeaningLookupEnabled = wordMeaningLookupEnabled(settings) ? "true" : "false";
        settings.aiModel = selectedAiModel(settings);
        if (settings.aiProvider !== normalizedProvider) {
          settings.aiProvider = normalizedProvider;
          void setSetting("aiProvider", normalizedProvider).catch((error) => showToast(String(error), "error"));
        }
        if (loaded.settings.autoTranslateAutostartMigrated !== "true") {
          settings.autoTranslate = "true";
          settings.autoTranslateAutostartMigrated = "true";
          void setSetting("autoTranslate", "true").catch((error) => showToast(String(error), "error"));
          void setSetting("autoTranslateAutostartMigrated", "true").catch((error) => showToast(String(error), "error"));
        }
        setState({ ...initialState, ...loaded, settings });
        if (loaded.documents.length > 0) {
          setActiveDocumentId(loaded.documents[0].id);
        }
      })
      .catch((error) => showToast(String(error), "error"));
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const providers: AiProviderKind[] = ["codex-cli", "claude-code", "local-draft"];
    Promise.all(providers.map(async (provider) => [provider, await getAgentProviderStatus(provider)] as const))
      .then((entries) => {
        if (!cancelled) {
          setAgentStatuses(Object.fromEntries(entries) as Partial<Record<AiProviderKind, AgentProviderStatus>>);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAgentStatuses({});
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const savedZoom = zoomFromSettings(state.settings, activeDocumentId);
    setZoom((current) => (Math.abs(current - savedZoom) < 0.001 ? current : savedZoom));
  }, [activeDocumentId, state.settings]);

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
  }, [activeDocumentId, pdfDocument, zoom, mode, outlineOpen, translationPanelOpen, rightPanelOpen, readerLayout, savedHorizontalScrollLeft]);

  useEffect(
    () => () => {
      if (scrollSaveTimerRef.current !== null) {
        window.clearTimeout(scrollSaveTimerRef.current);
      }
      if (readerScrollSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(readerScrollSyncFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!activeDocumentId || !state.documents.some((document) => document.id === activeDocumentId)) {
      setPdfDocument(null);
      setLoadedBytes(null);
      setPageImages({});
      setPdfOutlineRows([]);
      setPageOutlineAnchors({});
      setActiveOutlineId(null);
    }
  }, [activeDocumentId, state.documents]);

  useEffect(() => {
    const element = readerRef.current;
    if (!element || mode !== "reader") {
      return;
    }
    scheduleReaderCursorSync(element);
  }, [mode, activeDocumentId, activeOutlineRows, zoom]);

  useEffect(() => {
    function handleKeydown(event: KeyboardEvent) {
      const color = highlightColors.find((item) => item.key === event.key);
      if (selectionToolbar && color) {
        event.preventDefault();
        void createManualHighlight(color.value);
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  });

  const patchState = useCallback((mutator: (draft: AppStateRecord) => void) => {
    setState((current) => {
      const draft = structuredClone(current) as AppStateRecord;
      mutator(draft);
      return draft;
    });
  }, []);

  const showToast = useCallback((message: string, kind: ToastMessage["kind"] = "info") => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast({ message, kind });
    if (kind !== "error") {
      toastTimerRef.current = window.setTimeout(() => {
        setToast(null);
        toastTimerRef.current = null;
      }, 4200);
    }
  }, []);

  function persistLayoutPane(pane: LayoutPane, value: number) {
    const bounds = layoutBounds[pane];
    const next = Math.round(clampNumber(value, bounds.min, bounds.max));
    patchState((draft) => {
      draft.settings[bounds.setting] = String(next);
    });
    void setSetting(bounds.setting, String(next));
  }

  function startLayoutResize(pane: LayoutPane, event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startValue = readerLayout[pane];
    const direction = pane === "rightPanel" ? -1 : 1;
    let latest = startValue;
    const bounds = layoutBounds[pane];
    const handleMove = (moveEvent: PointerEvent) => {
      latest = Math.round(clampNumber(startValue + (moveEvent.clientX - startX) * direction, bounds.min, bounds.max));
      setLayoutOverride((current) => ({ ...current, [pane]: latest }));
    };
    const handleDone = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleDone);
      window.removeEventListener("pointercancel", handleDone);
      persistLayoutPane(pane, latest);
      window.setTimeout(() => {
        setLayoutOverride((current) => {
          const next = { ...current };
          delete next[pane];
          return next;
        });
      }, 0);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleDone);
    window.addEventListener("pointercancel", handleDone);
  }

  function commitZoom(nextZoom: number) {
    const next = Math.round(clampNumber(nextZoom, minReaderZoom, maxReaderZoom) * 100) / 100;
    setZoom(next);
    if (!activeDocumentId) {
      return;
    }
    const key = documentZoomSettingKey(activeDocumentId);
    patchState((draft) => {
      draft.settings[key] = String(next);
    });
    void setSetting(key, String(next));
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
    const markerTop = element.scrollTop + 72;
    const containerBox = element.getBoundingClientRect();
    let nextPage = Number(pageShells[0].dataset.page ?? 1) || 1;
    for (const shell of pageShells) {
      const page = Number(shell.dataset.page ?? 0);
      if (page > 0 && shell.offsetTop <= markerTop) {
        nextPage = page;
      } else {
        break;
      }
    }
    setPageCursor((current) => (current === nextPage ? current : nextPage));
    const currentShell = pageShells.find((shell) => Number(shell.dataset.page ?? 0) === nextPage);
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
    if (readerScrollSyncFrameRef.current !== null) {
      window.cancelAnimationFrame(readerScrollSyncFrameRef.current);
    }
    readerScrollSyncFrameRef.current = window.requestAnimationFrame(() => {
      readerScrollSyncFrameRef.current = null;
      syncReaderCursorFromScroll(element);
    });
  }

  async function loadPdfBytes(document: DocumentRecord, bytes?: Uint8Array) {
    setIsBusy(true);
    try {
      const pdfBytes = bytes ?? (await readDocumentBytes(document.id));
      setLoadedBytes(pdfBytes);
      setPdfOutlineRows([]);
      setPageOutlineAnchors({});
      setActiveOutlineId(null);
      const loadingTask = (pdfjsLib as unknown as { getDocument(options: { data: Uint8Array }): { promise: Promise<PdfDocumentProxy> } }).getDocument({
        data: pdfBytes,
      });
      const pdf = await loadingTask.promise;
      setPdfDocument(pdf);
      setPageCursor(1);
      setMode("reader");
      setActiveDocumentId(document.id);

      const [metadata, outline] = await Promise.all([
        pdf.getMetadata().catch(() => ({ info: {} })),
        pdf.getOutline().catch(() => null),
      ]);
      const mappedOutlineRows = outline?.length ? await flattenPdfOutlineRows(pdf, outline, pdf.numPages) : [];
      setPdfOutlineRows(mappedOutlineRows);
      const info = (metadata.info ?? {}) as { Title?: string; Author?: string; CreationDate?: string };
      const updated: DocumentRecord = {
        ...document,
        title: info.Title || document.title,
        authors: info.Author || document.authors,
        year: document.year || inferYear(info.CreationDate),
        pageCount: pdf.numPages,
        updatedAt: nowIso(),
      };
      const saved = await updateDocument(updated);
      patchState((draft) => {
        draft.documents = draft.documents.map((item) => (item.id === saved.id ? saved : item));
      });
    } catch (error) {
      showToast(`${ui.openPdfErrorPrefix}: ${String(error)}`, "error");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleFiles(files: FileList | File[]) {
    const pdfFiles = Array.from(files).filter((file) => file.type === "application/pdf" || file.name.endsWith(".pdf"));
    if (pdfFiles.length === 0) {
      showToast(ui.dropOrChoosePdf);
      return;
    }
    setIsBusy(true);
    try {
      const targetFolderId = folderFilter === "all" ? "root" : folderFilter;
      for (const file of pdfFiles) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let document = await importPdf(file.name, bytes);
        if (targetFolderId !== "root") {
          document = await updateDocument({ ...document, folderId: targetFolderId, updatedAt: nowIso() });
        }
        patchState((draft) => {
          draft.documents = [document, ...draft.documents.filter((item) => item.id !== document.id)];
        });
        await loadPdfBytes(document, bytes);
      }
    } catch (error) {
      showToast(`${ui.importFailedPrefix}: ${String(error)}`, "error");
    } finally {
      setIsBusy(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  function handleReaderMouseUp() {
    const selection = window.getSelection();
    const text = cleanSelection(selection?.toString() ?? "");
    if (!selection || text.length < 2 || selection.rangeCount === 0) {
      setSelectionToolbar(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const container =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement;
    let page = container?.closest<HTMLElement>(".pdf-page-shell") ?? null;
    const rangeRects = Array.from(range.getClientRects()).filter((rect) => rect.width > 1 && rect.height > 1);
    if (!page) {
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
      return;
    }
    const pageBounds = page.getBoundingClientRect();
    const rects = rangeRects
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
    const rect = range.getBoundingClientRect();
    const toolbar = {
      text,
      page: Number(page.dataset.page ?? "1"),
      x: rect.left + rect.width / 2,
      y: Math.max(72, rect.top - 46),
      rects,
    };
    if (markupTool.kind === "erase") {
      setSelectionToolbar(null);
      selection.removeAllRanges();
      return;
    }
    if (markupTool.kind === "highlight") {
      setSelectionToolbar(null);
      selection.removeAllRanges();
      void createManualHighlightFromToolbar(toolbar, markupTool.color);
      return;
    }
    setSelectionToolbar(toolbar);
  }

  function getCanvasPoint(event: React.MouseEvent) {
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

  function handleRegionMouseDown(event: React.MouseEvent) {
    if (!regionMode) {
      return;
    }
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

  function handleRegionMouseMove(event: React.MouseEvent) {
    if (!regionMode || !regionDrag) {
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

  async function finishRegionExplain(event: React.MouseEvent) {
    if (!regionMode) {
      handleReaderMouseUp();
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
    showToast(ui.explanationButtonSaved);
  }

  async function ensureActivePages(): Promise<PageRecord[]> {
    if (!activeDocument) {
      return [];
    }
    const expectedPageCount = Math.max(1, pdfDocument?.numPages ?? activeDocument.pageCount ?? activePages.length);
    if (activePages.length >= expectedPageCount) {
      return activePages;
    }
    if (!pdfDocument) {
      return activePages;
    }
    const extracted: PageRecord[] = [];
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const viewport = page.getViewport({ scale: defaultReaderZoom });
      const content = await page.getTextContent();
      const text = pageTextFromPdfItems(content.items, viewport, defaultReaderZoom);
      extracted.push({
        documentId: activeDocument.id,
        pageNumber,
        text,
        outlineLabel: text.split(/[.!?]\s+/)[0]?.slice(0, 90) || `Page ${pageNumber}`,
      });
    }
    await savePages(activeDocument.id, extracted);
    patchState((draft) => {
      draft.pages = draft.pages.filter((page) => page.documentId !== activeDocument.id).concat(extracted);
    });
    void persistWordListForPages(activeDocument.id, extracted).catch((error) =>
      showToast(`${ui.aiTaskFailedPrefix}: ${String(error)}`, "error"),
    );
    return extracted;
  }

  async function queueTask(
    taskType: AiTaskType,
    payload: Record<string, unknown>,
    options: { silent?: boolean; keepPanel?: boolean } = {},
  ): Promise<AiResultRecord | null> {
    if (!activeDocument) {
      if (!options.silent) {
        showToast(ui.openDocumentFirst);
      }
      return null;
    }
    try {
      const providerKind = normalizeAiProviderKind(state.settings.aiProvider);
      const needsPages =
        ["summarizePaper", "chatWithPaper", "autoHighlight", "outlineDocument", wordMeaningTaskType].includes(taskType) ||
        (taskType === "translatePage" && !payload.text);
      const payloadPages = Array.isArray(payload.pages) ? (payload.pages as PageRecord[]) : null;
      const pages = needsPages ? (payloadPages?.length ? payloadPages : await ensureActivePages()) : activePages;
      const taskPayload: Record<string, unknown> = {
        ...payload,
        ...(needsPages && !Array.isArray(payload.pages) ? { pages } : {}),
      };
      if (taskType === "translateText" || taskType === "translatePage") {
        taskPayload.translationLanguage = translationLanguageOption(state.settings.translationLanguage).value;
        taskPayload.translationLanguageName = translationLanguageNameFromSettings(state.settings);
      }
      if (taskType === "chatWithPaper" && typeof taskPayload.question === "string") {
        const chatPages = Array.isArray(taskPayload.pages) ? (taskPayload.pages as PageRecord[]) : pages;
        const contextPack =
          (taskPayload.documentContextPack as DocumentContextPack | undefined) ??
          buildDocumentContextPack(activeDocument, chatPages.length ? chatPages : pages, activeOutlineRows);
        const hasSelectedPageTexts =
          Array.isArray(taskPayload.selectedPageTexts) && taskPayload.selectedPageTexts.length > 0;
        const isPlannedFinal = taskPayload.askMode === "planned" || hasSelectedPageTexts;
        taskPayload.documentContextPack = contextPack;
        delete taskPayload.ragContext;
        if (!isPlannedFinal && providerKind !== "local-draft" && contextPack.totalTextChars > shortAskFullTextLimit) {
          const providerSessionId = latestProviderSessionId(activeAiResults, providerKind);
          const queued = await runAiTask(providerKind, bridgePath, chatPlanTaskType, activeDocument, {
            question: taskPayload.question,
            askMode: "planned",
            documentContextPack: contextPack,
            customPrompt: state.settings.customPrompt,
            mathDelimiter: state.settings.mathDelimiter,
            model: selectedAiModel(state.settings),
            reasoningEffort: providerKind === "codex-cli" ? selectedCodexReasoningEffort(state.settings) : "",
            providerSessionId,
          });
          patchState((draft) => {
            draft.aiResults = [queued, ...draft.aiResults.filter((item) => item.id !== queued.id)];
          });
          setAssistantMode("study");
          if (!options.keepPanel) {
            setActivePanel("ai");
          }
          if (queued.status === "pending" && isAgentProvider(providerKind)) {
            const worker = await startBridgeWorker(bridgePath, queued.id);
            if (worker.started) {
              if (!options.silent) {
                showToast(`${ui.taskStartedPrefix} ${taskTitle("chatWithPaper", ui)}.`);
              }
            } else {
              await saveLocalAiResult({
                ...queued,
                outputText: `${queued.outputText}\n\nAgent worker not started automatically: ${worker.message}`,
                status: "pending",
              });
              if (!options.silent) {
                showToast(`${taskTitle("chatWithPaper", ui)} ${ui.taskQueuedSuffix}`);
              }
            }
          } else if (!options.silent) {
            showToast(`${ui.taskCompletedPrefix} ${taskTitle("chatWithPaper", ui)}.`);
          }
          return queued;
        }
        if (!hasSelectedPageTexts) {
          taskPayload.askMode = "direct";
          taskPayload.selectedPageTexts = selectedPageTextsFromPages(
            chatPages.length ? chatPages : pages,
            Math.max(shortAskFullTextLimit, contextPack.totalTextChars + 1024),
            Number.MAX_SAFE_INTEGER,
          );
        } else {
          taskPayload.askMode = "planned";
        }
      }
      if (taskType === "translatePage" && !taskPayload.text && typeof taskPayload.page === "number") {
        taskPayload.text = pages.find((page) => page.pageNumber === taskPayload.page)?.text ?? "";
      }
      const explicitProviderSessionId =
        typeof taskPayload.providerSessionId === "string" ? taskPayload.providerSessionId : "";
      const providerSessionId =
        explicitProviderSessionId ||
        (taskType === "chatWithPaper" || taskType === chatPlanTaskType
          ? latestProviderSessionId(activeAiResults, providerKind)
          : "");
      const queued = await runAiTask(providerKind, bridgePath, taskType, activeDocument, {
        ...taskPayload,
        customPrompt: state.settings.customPrompt,
        mathDelimiter: state.settings.mathDelimiter,
        model: selectedAiModel(state.settings),
        reasoningEffort: providerKind === "codex-cli" ? selectedCodexReasoningEffort(state.settings) : "",
        providerSessionId,
      });
      patchState((draft) => {
        draft.aiResults = [queued, ...draft.aiResults.filter((item) => item.id !== queued.id)];
      });
      setAssistantMode(taskType === "citationReason" || taskType === "externalLinkSummary" ? "quotes" : "study");
      if (taskType === "explainText" || taskType === "explainRegionImage") {
        setFloatingResultId(queued.id);
        setRightPanelOpen(true);
      }
      if (!options.keepPanel) {
        setActivePanel("ai");
      }
      if (queued.status === "pending" && isAgentProvider(providerKind)) {
        const worker = await startBridgeWorker(bridgePath, queued.id);
        if (worker.started) {
          if (!options.silent) {
            showToast(`${ui.taskStartedPrefix} ${taskTitle(taskType, ui)}.`);
          }
        } else {
          await saveLocalAiResult({
            ...queued,
            outputText: `${queued.outputText}\n\nAgent worker not started automatically: ${worker.message}`,
            status: "pending",
          });
          if (!options.silent) {
            showToast(`${taskTitle(taskType, ui)} ${ui.taskQueuedSuffix}`);
          }
        }
      } else {
        if (!options.silent) {
          showToast(`${ui.taskCompletedPrefix} ${taskTitle(taskType, ui)}.`);
        }
      }
      return queued;
    } catch (error) {
      if (!options.silent) {
        showToast(`${ui.aiTaskFailedPrefix}: ${String(error)}`, "error");
      }
      return null;
    }
  }

  async function queueTranslationForPage(
    page: PageRecord,
    options: { silent?: boolean; force?: boolean } = {},
  ): Promise<AiResultRecord | null> {
    if (!activeDocument || !page.text || page.text.length < 12) {
      return null;
    }
    const targetLanguage = translationLanguageNameFromSettings(state.settings);
    if (!options.force && hasTranslationRequestForPage(activeAiResults, page, targetLanguage)) {
      return null;
    }
    const requestKey = translationRequestKey(activeDocument.id, page.pageNumber, page.text, targetLanguage);
    const queuedAt = translationRequestsRef.current.get(requestKey);
    if (!options.force && queuedAt && Date.now() - queuedAt < stalePendingTranslationMs) {
      return null;
    }
    translationRequestsRef.current.set(requestKey, Date.now());
    const queued = await queueTask(
      "translatePage",
      {
        page: page.pageNumber,
        text: page.text,
        sentences: sentenceUnitsForPage(page).map((unit) => ({
          id: unit.id,
          source: unit.source,
        })),
      },
      { silent: options.silent ?? true, keepPanel: true },
    );
    if (!queued) {
      translationRequestsRef.current.delete(requestKey);
    }
    return queued;
  }

  async function queueAutoTranslationForPageNumber(pageNumber: number): Promise<AiResultRecord | null> {
    if (state.settings.autoTranslate !== "true") {
      return null;
    }
    const page = activePages.find((candidate) => candidate.pageNumber === pageNumber);
    if (!page || page.text.length < 12) {
      return null;
    }
    return queueTranslationForPage(page, { silent: true });
  }

  async function refreshTranslationForPage(page: PageRecord) {
    const targetLanguage = translationLanguageNameFromSettings(state.settings);
    const existingIds = translationResultsForPage(activeAiResults, page, targetLanguage).map((result) => result.id);
    const queued = await queueTranslationForPage(page, { silent: false, force: true });
    if (!queued || existingIds.length === 0) {
      return;
    }
    await deleteAiResults(existingIds);
    const idSet = new Set(existingIds);
    patchState((draft) => {
      draft.aiResults = draft.aiResults.filter((result) => !idSet.has(result.id));
    });
  }

  async function persistWordListForPages(documentId: string, pages: PageRecord[]) {
    const document = state.documents.find((item) => item.id === documentId) ?? activeDocument;
    const candidates = extractDocumentTermCandidates(pages, document);
    const terms = candidates.map((candidate) => candidate.term);
    if (terms.length === 0) {
      return terms;
    }
    const key = documentWordListSettingKey(documentId);
    const value = JSON.stringify({
      terms,
      candidates: candidates.slice(0, 1500),
    });
    if (state.settings[key] === value) {
      return terms;
    }
    patchState((draft) => {
      draft.settings[key] = value;
    });
    await setSetting(key, value);
    return terms;
  }

  async function saveWordMeaningsFromResult(result: AiResultRecord, fallbackWords: string[] = []) {
    if (result.status === "failed" || result.taskType.toString() !== wordMeaningTaskType) {
      return 0;
    }
    const requestedTerms = requestedWordMeaningTerms(result, fallbackWords);
    const meanings = parseWordMeaningItems(result.outputText, fallbackWords)
      .filter((item) => requestedTerms.size === 0 || requestedTerms.has(normalizeWordKey(item.word)))
      .slice(0, wordMeaningBatchLimit);
    if (meanings.length === 0) {
      return 0;
    }
    const document = state.documents.find((item) => item.id === result.documentId) ?? activeDocument;
    const nextMap = wordMeaningMapFromSettings(state.settings);
    let added = 0;
    for (const item of meanings) {
      const key = normalizeWordKey(item.word);
      const meaning = item.meaning.trim();
      if (!key || !meaning) {
        continue;
      }
      const entries = nextMap[key] ?? [];
      const duplicate = entries.some(
        (entry) =>
          entry.documentId === result.documentId &&
          normalizeComparable(entry.meaning) === normalizeComparable(meaning) &&
          normalizeComparable(entry.context) === normalizeComparable(item.context),
      );
      if (duplicate) {
        continue;
      }
      entries.push({
        id: makeId("wm"),
        word: key,
        meaning,
        documentId: result.documentId,
        documentTitle: document?.title || document?.fileName || ui.untitledPaper,
        context: item.context,
        createdAt: nowIso(),
        source: result.provider === "local-draft" ? "local" : "ai",
      });
      nextMap[key] = entries;
      added += 1;
    }
    if (added === 0) {
      return 0;
    }
    const value = JSON.stringify(nextMap);
    patchState((draft) => {
      draft.settings[wordMeaningMapSettingKey] = value;
    });
    await setSetting(wordMeaningMapSettingKey, value);
    const requestedCount = requestedTerms.size || meanings.length;
    const remaining = Math.max(0, requestedCount - added);
    showToast(
      uiLanguage === "ko"
        ? `단어 뜻 저장: 요청 ${requestedCount}개 / 저장 ${added}개 / 남음 ${remaining}개`
        : `Word meanings: requested ${requestedCount} / saved ${added} / remaining ${remaining}`,
    );
    return added;
  }

  async function persistWordMeaningMap(nextMap: WordMeaningMap) {
    const value = JSON.stringify(nextMap);
    patchState((draft) => {
      draft.settings[wordMeaningMapSettingKey] = value;
    });
    await setSetting(wordMeaningMapSettingKey, value);
  }

  async function saveOnlineDictionaryMeanings(documentId: string, terms: string[], baseMap?: WordMeaningMap) {
    const document = state.documents.find((item) => item.id === documentId) ?? activeDocument;
    const nextMap = Object.fromEntries(
      Object.entries(baseMap ?? wordMeaningMapFromSettings(state.settings)).map(([key, entries]) => [key, [...entries]]),
    ) as WordMeaningMap;
    const cache = onlineDictionaryCacheFromSettings(state.settings);
    const lookupTerms = [...new Set(terms.map(normalizeWordKey))]
      .filter((term) => term && !term.includes(" ") && !hasUsableWordMeaning(nextMap[term]))
      .slice(0, onlineDictionaryBatchLimit);
    const unresolved = lookupTerms.filter(
      (term) =>
        cache[term]?.parserVersion !== onlineDictionaryParserVersion ||
        !normalizeOnlineDictionaryMeaning(cache[term]?.meaning ?? ""),
    );
    let cacheChanged = false;
    if (unresolved.length > 0) {
      const fetched = await mapWithConcurrency(unresolved, 6, async (term) => ({
        term,
        meaning: normalizeOnlineDictionaryMeaning(await fetchOnlineDictionaryMeaning(term)),
      }));
      for (const item of fetched) {
        cache[item.term] = {
          meaning: item.meaning,
          source: onlineDictionarySourceLabel,
          fetchedAt: nowIso(),
          parserVersion: onlineDictionaryParserVersion,
        };
        cacheChanged = true;
      }
    }
    for (const term of lookupTerms) {
      const cached = cache[term];
      if (!cached) {
        continue;
      }
      const meaning = normalizeOnlineDictionaryMeaning(cached.meaning);
      if (cached.meaning !== meaning) {
        cached.meaning = meaning;
        cached.source = onlineDictionarySourceLabel;
        cached.parserVersion = onlineDictionaryParserVersion;
        cacheChanged = true;
      }
    }
    if (cacheChanged) {
      const cacheValue = JSON.stringify(cache);
      patchState((draft) => {
        draft.settings[onlineDictionaryCacheSettingKey] = cacheValue;
      });
      await setSetting(onlineDictionaryCacheSettingKey, cacheValue);
    }
    let added = 0;
    for (const term of lookupTerms) {
      const cached = cache[term];
      const meaning = normalizeOnlineDictionaryMeaning(cached?.meaning ?? "");
      if (!meaning) {
        continue;
      }
      const entries = nextMap[term] ?? [];
      const duplicate = entries.some(
        (entry) =>
          entry.source === "dictionary" &&
          normalizeComparable(entry.meaning) === normalizeComparable(meaning),
      );
      if (duplicate) {
        continue;
      }
      entries.push({
        id: makeId("wm"),
        word: term,
        meaning,
        documentId,
        documentTitle: document?.title || document?.fileName || ui.untitledPaper,
        context: cached.source || onlineDictionarySourceLabel,
        createdAt: nowIso(),
        source: "dictionary",
      });
      nextMap[term] = entries;
      added += 1;
    }
    if (added > 0) {
      await persistWordMeaningMap(nextMap);
    }
    return { added, map: nextMap };
  }

  async function saveFallbackDictionaryMeanings(documentId: string, terms: string[], baseMap?: WordMeaningMap) {
    const document = state.documents.find((item) => item.id === documentId) ?? activeDocument;
    const nextMap = Object.fromEntries(
      Object.entries(baseMap ?? wordMeaningMapFromSettings(state.settings)).map(([key, entries]) => [key, [...entries]]),
    ) as WordMeaningMap;
    let added = 0;
    for (const term of terms) {
      const key = normalizeWordKey(term);
      const meaning = basicDictionaryMeaning(key);
      if (!key || !meaning || hasUsableWordMeaning(nextMap[key])) {
        continue;
      }
      const entries = nextMap[key] ?? [];
      const duplicate = entries.some(
        (entry) =>
          entry.source === "local" &&
          normalizeComparable(entry.meaning) === normalizeComparable(meaning) &&
          normalizeComparable(entry.context) === normalizeComparable("basic dictionary"),
      );
      if (duplicate) {
        continue;
      }
      entries.push({
        id: makeId("wm"),
        word: key,
        meaning,
        documentId,
        documentTitle: document?.title || document?.fileName || ui.untitledPaper,
        context: "offline fallback dictionary",
        createdAt: nowIso(),
        source: "local",
      });
      nextMap[key] = entries;
      added += 1;
    }
    if (added > 0) {
      await persistWordMeaningMap(nextMap);
    }
    return { added, map: nextMap };
  }

  async function queueMissingWordMeanings() {
    if (!activeDocument) {
      showToast(ui.openDocumentFirst);
      return;
    }
    const pages = activePages.length ? activePages : await ensureActivePages();
    if (pages.length === 0 || pages.every((page) => !page.text.trim())) {
      showToast(ui.wordMeaningNoText);
      return;
    }
    const candidates = extractDocumentTermCandidates(pages, activeDocument);
    const terms = candidates.map((candidate) => candidate.term);
    const storedTerms = terms.length ? await persistWordListForPages(activeDocument.id, pages) : activeDocumentWordList;
    if (storedTerms.length === 0) {
      showToast(ui.wordMeaningNoText);
      return;
    }
    const currentMap = wordMeaningMapFromSettings(state.settings);
    const missingCandidates = candidates
      .filter((candidate) => {
        if (!candidate.contextNeeded) {
          return false;
        }
        const entries = currentMap[normalizeWordKey(candidate.term)] ?? [];
        return !entries.some((entry) => entry.source === "ai" && entry.documentId === activeDocument.id);
      })
      .sort((a, b) => b.score - a.score || b.count - a.count || a.term.localeCompare(b.term));
    const missingTerms = missingCandidates.slice(0, wordMeaningBatchLimit).map((candidate) => candidate.term);
    if (missingTerms.length === 0) {
      showToast(ui.wordMeaningNoMissing);
      return;
    }
    const queued = await queueTask(
      wordMeaningTaskType,
      {
        mode: "initial",
        words: missingTerms,
        candidateTerms: missingCandidates.slice(0, wordMeaningBatchLimit),
        pages,
      },
      { keepPanel: true },
    );
    if (!queued) {
      return;
    }
    if (queued.status === "pending") {
      showToast(
        uiLanguage === "ko"
          ? `단어 뜻 생성 중: 요청 ${missingTerms.length}개 / 전체 후보 ${storedTerms.length}개`
          : `Building word meanings: requested ${missingTerms.length} / total candidates ${storedTerms.length}`,
      );
    } else {
      await saveWordMeaningsFromResult(queued, missingTerms);
    }
  }

  async function queueAdjustedWordMeaning(popup: WordPopup) {
    if (!activeDocument) {
      showToast(ui.openDocumentFirst);
      return;
    }
    const word = normalizeWordKey(popup.word);
    if (!word) {
      return;
    }
    const pages = activePages.length ? activePages : await ensureActivePages();
    const page = pages.find((item) => item.pageNumber === popup.page);
    const existingMeanings = (wordMeaningMap[normalizeWordKey(word)] ?? []).map((entry) => ({
      meaning: entry.meaning,
      context: entry.context,
      documentTitle: entry.documentTitle,
    }));
    const queued = await queueTask(
      wordMeaningTaskType,
      {
        mode: "adjust",
        words: [word],
        page: popup.page,
        context: popup.context,
        existingMeanings,
        pages: page ? [page] : pages.slice(0, 3),
      },
      { keepPanel: true },
    );
    if (!queued) {
      return;
    }
    if (queued.status === "pending") {
      showToast(ui.wordMeaningAdjustQueued);
    } else {
      await saveWordMeaningsFromResult(queued, [word]);
    }
  }

  async function saveLocalAiResult(result: AiResultRecord) {
    const saved = await saveAiResult(result);
    patchState((draft) => {
      draft.aiResults = [saved, ...draft.aiResults.filter((item) => item.id !== saved.id)];
    });
    return saved;
  }

  async function saveAutoHighlightsFromResult(result: AiResultRecord) {
    if (!activeDocument || result.taskType.toString() !== "autoHighlight" || result.status === "failed") {
      return;
    }
    const fallbackPage = Number(result.inputText.match(/page\s+(\d+)/i)?.[1] ?? pageCursor) || pageCursor;
    const candidates = parseAutoHighlightCandidates(result.outputText, fallbackPage);
    if (candidates.length === 0) {
      return;
    }
    const existing = new Set(activeAnnotations.map(annotationKey));
    let savedCount = 0;
    for (const candidate of candidates) {
      const annotation: AnnotationRecord = {
        id: makeId("auto"),
        documentId: activeDocument.id,
        page: candidate.page,
        kind: "auto",
        color: colorForHighlightTag(candidate.tag),
        text: candidate.text,
        rangeHint: candidate.text.slice(0, 180),
        rects: [],
        comment: candidate.reason,
        tag: candidate.tag,
        createdAt: nowIso(),
      };
      const key = annotationKey(annotation);
      if (existing.has(key)) {
        continue;
      }
      existing.add(key);
      const saved = await upsertAnnotation(annotation);
      savedCount += 1;
      patchState((draft) => {
        draft.annotations = [saved, ...draft.annotations.filter((item) => item.id !== saved.id)];
      });
    }
    if (savedCount > 0) {
      showToast(`${savedCount}${uiLanguage === "ko" ? "" : " "}${ui.highlightsAddedSuffix}`);
    }
  }

  async function pollBridge(silent = false) {
    const pending = activeAiResults.filter((result) => result.status === "pending");
    if (pending.length === 0) {
      if (!silent) {
        showToast(ui.noPendingAgentTasks);
      }
      return;
    }
    let received = 0;
    for (const item of pending) {
      const bridgeResult = await readBridgeResult(bridgePath, item.id);
      if (bridgeResult) {
        received += 1;
        const metadata = bridgeResult.payload as Record<string, unknown>;
        const nestedPayload =
          metadata.payload && typeof metadata.payload === "object"
            ? (metadata.payload as Record<string, unknown>)
            : {};
        const provider =
          typeof metadata.provider === "string"
            ? metadata.provider
            : typeof nestedPayload.provider === "string"
              ? nestedPayload.provider
              : item.provider;
        const model =
          typeof metadata.model === "string"
            ? metadata.model
            : typeof nestedPayload.model === "string"
              ? nestedPayload.model
              : item.model;
        const providerSessionId =
          typeof metadata.providerSessionId === "string"
            ? metadata.providerSessionId
            : typeof nestedPayload.providerSessionId === "string"
              ? nestedPayload.providerSessionId
              : item.providerSessionId;
        if (item.taskType.toString() === chatPlanTaskType) {
          const sourcePages = activePages.length ? activePages : await ensureActivePages();
          const pageCount = Math.max(activeDocument?.pageCount ?? 0, sourcePages.at(-1)?.pageNumber ?? 0, sourcePages.length, 1);
          const output = bridgeResult.output || JSON.stringify(bridgeResult.payload, null, 2);
          const parsedPlan = bridgeResult.status === "failed" ? null : parseAiRetrievalPlan(output, pageCount);
          const retrievalPlan = parsedPlan ?? fallbackRetrievalPlan(item.inputText, sourcePages, pageCount);
          const plannedPageTexts = selectedPageTextsForPlan(sourcePages, retrievalPlan, pageCount);
          const selectedPageTexts = plannedPageTexts.length
            ? plannedPageTexts
            : selectedPageTextsFromPages(sourcePages, selectedAskPageTextLimit, selectedAskPageMaxCount);
          if (activeDocument) {
            await deleteAiResults([item.id]);
            patchState((draft) => {
              draft.aiResults = draft.aiResults.filter((result) => result.id !== item.id);
            });
            await queueTask(
              "chatWithPaper",
              {
                question: item.inputText,
                askMode: "planned",
                documentContextPack: buildDocumentContextPack(activeDocument, sourcePages, activeOutlineRows),
                retrievalPlan,
                selectedPageTexts,
                providerSessionId: providerSessionId ?? "",
              },
              { silent: true },
            );
          }
          continue;
        }
        const savedResult = await saveLocalAiResult({
          ...item,
          outputText: bridgeResult.output || JSON.stringify(bridgeResult.payload, null, 2),
          status: bridgeResult.status || "complete",
          provider,
          model,
          providerSessionId,
        });
        if (item.taskType.toString() === "translatePage") {
          const page = activePages.find((candidate) => normalizeComparable(candidate.text) === normalizeComparable(translationInputText(item)));
          if (page) {
            translationRequestsRef.current.delete(
              translationRequestKey(item.documentId, page.pageNumber, page.text, translationInputLanguage(item)),
            );
          }
        }
        if (savedResult.taskType.toString() === "autoHighlight") {
          await saveAutoHighlightsFromResult(savedResult);
        }
        if (savedResult.taskType.toString() === wordMeaningTaskType) {
          await saveWordMeaningsFromResult(savedResult);
        }
        if (item.taskType.toString() === "translatePage" && bridgeResult.status === "failed") {
          const page = activePages.find((candidate) => normalizeComparable(candidate.text) === normalizeComparable(translationInputText(item)));
          if (page) {
            translationRequestsRef.current.delete(
              translationRequestKey(item.documentId, page.pageNumber, page.text, translationInputLanguage(item)),
            );
          }
        }
        if (["explainText", "explainRegionImage", "translateText"].includes(item.taskType.toString())) {
          setFloatingResultId(item.id);
        }
      }
    }
    if (!silent) {
      showToast(received ? `${received}${uiLanguage === "ko" ? "" : " "}${ui.receivedAgentResultsSuffix}` : ui.agentInboxChecked);
    }
  }

  async function runPendingBridgeWorkers() {
    const pending = activeAiResults.filter((result) => result.status === "pending");
    if (pending.length === 0) {
      showToast(ui.noPendingAgentTasks);
      return;
    }
    let started = 0;
    let lastFailure = "";
    for (const item of pending) {
      const worker = await startBridgeWorker(bridgePath, item.id);
      if (worker.started) {
        started += 1;
      } else {
        lastFailure = worker.message;
      }
    }
    showToast(started ? `${ui.taskStartedPrefix} ${started} ${ui.agentPending}.` : lastFailure || ui.noAgentWorkerStarted);
  }

  function scrollPdfSentenceIntoView(id: string) {
    window.setTimeout(() => {
      const target = Array.from(document.querySelectorAll<HTMLElement>(".text-layer [data-sentence-id]")).find(
        (node) => node.dataset.sentenceId === id,
      );
      target?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    }, 80);
  }

  function selectSentenceAndScroll(id: string) {
    setSelectedSentenceId(id);
    const page = Number(id.match(/^p(\d+)-(?:s|ai)\d+$/)?.[1] ?? 0);
    if (page > 0 && page !== pageCursor) {
      setPageCursor(page);
    }
    scrollPdfSentenceIntoView(id);
  }

  function openWordMeaningPopup(popup: WordPopup) {
    if (markupTool.kind !== "none" || !wordMeaningLookupEnabled(state.settings)) {
      return;
    }
    const term = bestTermForWordPopup(popup, activeDocumentWordList, wordMeaningMap);
    setWordPopup({ ...popup, word: term });
    if (activeDocument && term && !term.includes(" ") && !hasUsableWordMeaning(wordMeaningMap[normalizeWordKey(term)])) {
      const key = normalizeWordKey(term);
      setWordLookupLoadingKey(key);
      void saveOnlineDictionaryMeanings(activeDocument.id, [term])
        .then((result) =>
          result.map[key]?.length
            ? result
            : saveFallbackDictionaryMeanings(activeDocument.id, [term], result.map),
        )
        .catch((error) => showToast(`${ui.aiTaskFailedPrefix}: ${String(error)}`, "error"))
        .finally(() => setWordLookupLoadingKey((current) => (current === key ? null : current)));
    }
  }

  useEffect(() => {
    if (!wordPopup) {
      return;
    }
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".word-meaning-popover")) {
        return;
      }
      setWordPopup(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer, true);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
  }, [wordPopup]);

  useEffect(() => {
    if (
      !activeAiResults.some(
        (result) => result.status === "pending" && (result.taskType.toString() !== "translatePage" || !isStalePendingTranslation(result)),
      )
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      void pollBridge(true);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activeAiResults, bridgePath]);

  useEffect(() => {
    setSelectedSentenceId(null);
    setWordPopup(null);
    setTranslationEligiblePages(new Set([1]));
  }, [activeDocumentId]);

  useEffect(() => {
    setSelectedSentenceId((current) => {
      const selectedPage = Number(current?.match(/^p(\d+)-(?:s|ai)\d+$/)?.[1] ?? 0);
      return selectedPage === pageCursor ? current : null;
    });
  }, [pageCursor]);

  useEffect(() => {
    if (state.settings.autoTranslate !== "true" || !activeDocument || !pdfDocument) {
      return;
    }
    const documentId = activeDocument.id;
    let cancelled = false;
    async function queueNextPage() {
      if (cancelled || activePages.length === 0) {
        return;
      }
      const pages = activePages;
      const providerKind = normalizeAiProviderKind(state.settings.aiProvider);
      const targetLanguage = translationLanguageNameFromSettings(state.settings);
      const hasInteractivePending =
        providerKind !== "local-draft" &&
        activeAiResults.some((result) => result.status === "pending" && result.taskType.toString() !== "translatePage");
      if (hasInteractivePending) {
        return;
      }
      const pendingCount = pages.filter((page) => pendingTranslationResultForPage(activeAiResults, page, targetLanguage)).length;
      const queueLimit = providerKind === "local-draft" ? pages.length : 1;
      const capacity = Math.max(0, queueLimit - pendingCount);
      if (capacity === 0) {
        return;
      }
      const candidates = pages
        .filter((page) => page.text.length >= 12 && translationEligiblePages.has(page.pageNumber))
        .sort((a, b) => a.pageNumber - b.pageNumber)
        .flatMap((page) => {
          if (!hasTranslationRequestForPage(activeAiResults, page, targetLanguage)) {
            return [{ page, force: false }];
          }
          if (
            normalizeAiProviderKind(state.settings.aiProvider) !== "local-draft" &&
            hasCompleteTranslationResultForPage(activeAiResults, page, targetLanguage) &&
            !isPageFullyTranslated(page, activeAiResults, targetLanguage) &&
            !pendingTranslationResultForPage(activeAiResults, page, targetLanguage)
          ) {
            const retryKey = translationRequestKey(documentId, page.pageNumber, page.text, targetLanguage);
            const retryCount = incompleteTranslationRetriesRef.current.get(retryKey) ?? 0;
            if (retryCount < 1) {
              incompleteTranslationRetriesRef.current.set(retryKey, retryCount + 1);
              return [{ page, force: true }];
            }
          }
          return [];
        })
        .slice(0, capacity);
      for (const candidate of candidates) {
        if (cancelled) {
          return;
        }
        await queueTranslationForPage(candidate.page, { silent: true, force: candidate.force });
      }
    }
    void queueNextPage();
    return () => {
      cancelled = true;
    };
  }, [state.settings.autoTranslate, state.settings.aiProvider, state.settings.translationLanguage, activeDocument?.id, activeDocument?.pageCount, pdfDocument, activePages.length, activeAiResults, translationEligiblePages]);

  useEffect(() => {
    if (!activeDocument || !pdfDocument) {
      return;
    }
    const hasUsableAiOutline = parseAiOutlineRows(activeAiResults, activePages).length > 0;
    if (hasUsableAiOutline || hasFreshPendingOutlineResult(activeAiResults) || outlineRequestsRef.current.has(activeDocument.id)) {
      return;
    }
    const document = activeDocument;
    const documentId = document.id;
    const pdfPageCount = pdfDocument.numPages;
    let cancelled = false;
    outlineRequestsRef.current.add(documentId);
    async function queueInitialAiOutline() {
      const pages = await ensureActivePages();
      if (cancelled) {
        return;
      }
      const expectedPages = Math.max(1, document.pageCount || pdfPageCount || pages.length || 1);
      const outlinePages = outlinePagesForAi(pages, expectedPages);
      if (outlinePages.length === 0) {
        outlineRequestsRef.current.delete(documentId);
        return;
      }
      const queued = await queueTask("outlineDocument", { pages: outlinePages }, { silent: true, keepPanel: true });
      if (!queued) {
        outlineRequestsRef.current.delete(documentId);
      }
    }
    void queueInitialAiOutline();
    return () => {
      cancelled = true;
    };
  }, [activeDocument?.id, activeDocument?.pageCount, pdfDocument, activePages.length, activeAiResults]);

  useEffect(() => {
    if (state.settings.autoHighlight !== "true" || !activeDocument || !pdfDocument) {
      return;
    }
    void runAutoHighlightForCurrentPage({ silent: true });
  }, [state.settings.autoHighlight, activeDocument?.id, pdfDocument, pageCursor, activePages.length, activeAiResults, activeAnnotations]);

  async function createPageText(page: PageRecord) {
    setState((current) => {
      const existing = current.pages.find(
        (item) => item.documentId === page.documentId && item.pageNumber === page.pageNumber,
      );
      if (
        existing &&
        existing.text === page.text &&
        existing.outlineLabel === page.outlineLabel
      ) {
        return current;
      }
      const draft = structuredClone(current) as AppStateRecord;
      draft.pages = draft.pages
        .filter((item) => !(item.documentId === page.documentId && item.pageNumber === page.pageNumber))
        .concat(page);
      return draft;
    });
    if (state.settings.autoTranslate === "true" && translationEligiblePages.has(page.pageNumber)) {
      void queueTranslationForPage(page, { silent: true });
    }
    const pagesForWords = activePages
      .filter((item) => !(item.documentId === page.documentId && item.pageNumber === page.pageNumber))
      .concat(page)
      .sort((a, b) => a.pageNumber - b.pageNumber);
    void persistWordListForPages(page.documentId, pagesForWords).catch((error) =>
      showToast(`${ui.aiTaskFailedPrefix}: ${String(error)}`, "error"),
    );
  }

  function rememberPageImage(pageNumber: number, image: string) {
    setPageImages((current) => {
      if (current[pageNumber] === image) {
        return current;
      }
      return { ...current, [pageNumber]: image };
    });
  }

  useEffect(() => {
    if (!activeDocument || activePages.length === 0 || activePages.length < activeDocument.pageCount) {
      return;
    }
    const pages = activePages.map((page) => ({ ...page, documentId: activeDocument.id }));
    void savePages(activeDocument.id, pages).catch((error) => showToast(`${ui.couldNotSavePageTextPrefix}: ${String(error)}`, "error"));
  }, [activeDocument?.id, activeDocument?.pageCount, activePages.length]);

  async function runAutoHighlightForCurrentPage(options: { silent?: boolean; force?: boolean } = {}) {
    if (!activeDocument) {
      return;
    }
    const pages = activePages.length ? activePages : await ensureActivePages();
    const page = pages.find((item) => item.pageNumber === pageCursor);
    if (!page || page.text.length < 12) {
      if (!options.silent) {
        showToast(ui.noExtractableTextCurrentPage);
      }
      return;
    }
    const requestKey = autoHighlightRequestKey(activeDocument.id, page.pageNumber, page.text);
    const queuedAt = autoHighlightRequestsRef.current.get(requestKey);
    const hasRecentRequest = Boolean(queuedAt && Date.now() - queuedAt < stalePendingTranslationMs);
    if (!options.force && options.silent && hasRecentRequest) {
      return;
    }
    const shouldQueueAgent =
      options.force || (!hasRecentRequest && !hasAutoHighlightRequestForPage(activeAiResults, page));
    if (shouldQueueAgent) {
      autoHighlightRequestsRef.current.set(requestKey, Date.now());
      await queueTask("autoHighlight", { page: page.pageNumber, pages: [page] }, { silent: true, keepPanel: true });
    }
    const existing = new Set(activeAnnotations.map(annotationKey));
    const generated = createAutoHighlights(activeDocument.id, [page]).filter((annotation) => {
      const key = annotationKey(annotation);
      if (existing.has(key)) {
        return false;
      }
      existing.add(key);
      return true;
    });
    for (const annotation of generated) {
      const saved = await upsertAnnotation(annotation);
      patchState((draft) => {
        draft.annotations = [saved, ...draft.annotations.filter((item) => item.id !== saved.id)];
      });
    }
    if (!options.silent) {
      if (generated.length === 0 && !shouldQueueAgent) {
        showToast(ui.autoHighlightAlreadyQueued);
      } else if (generated.length === 0) {
        showToast(ui.queuedAutoHighlightCurrentPage);
      } else {
        showToast(`${generated.length}${uiLanguage === "ko" ? "" : " "}${ui.highlightedLocalCandidatesSuffix}`);
      }
    }
  }

  async function extractCitationCards() {
    if (!activeDocument) {
      return;
    }
    const cards = extractReferences(activeDocument.id, activePages);
    for (const card of cards) {
      const saved = await upsertCitationCard(card);
      patchState((draft) => {
        draft.citationCards = [saved, ...draft.citationCards.filter((item) => item.id !== saved.id)];
      });
    }
    setActivePanel("citations");
    showToast(cards.length ? `${cards.length}${uiLanguage === "ko" ? "" : " "}${ui.citationCardsExtractedSuffix}` : ui.noReferencesFoundYet);
  }

  async function resolveCitationLinks() {
    if (!activeDocument) {
      return;
    }
    const baseCards = activeCitations.length ? activeCitations : extractReferences(activeDocument.id, activePages);
    if (baseCards.length === 0) {
      showToast(ui.noCitationsForLinks, "error");
      return;
    }
    setIsBusy(true);
    let linked = 0;
    try {
      for (const card of baseCards.slice(0, 30)) {
        const resolved = await resolveCitationLink(card);
        if (resolved.url || resolved.doi) {
          linked += 1;
        }
        const saved = await upsertCitationCard(resolved);
        patchState((draft) => {
          draft.citationCards = [saved, ...draft.citationCards.filter((item) => item.id !== saved.id)];
        });
      }
      setActivePanel("citations");
      showToast(`${linked}${uiLanguage === "ko" ? "" : " "}${ui.citationLinksConnectedSuffix}`);
    } catch (error) {
      showToast(`${ui.citationLinkFailedPrefix}: ${String(error)}`, "error");
    } finally {
      setIsBusy(false);
    }
  }

  async function updateMetadata(field: keyof DocumentRecord, value: string | boolean | null) {
    if (!activeDocument) {
      return;
    }
    const updated = await updateDocument({ ...activeDocument, [field]: value });
    patchState((draft) => {
      draft.documents = draft.documents.map((item) => (item.id === updated.id ? updated : item));
    });
  }

  async function toggleDocumentBookmark(document: DocumentRecord) {
    const updated = await updateDocument({ ...document, bookmarked: !document.bookmarked });
    patchState((draft) => {
      draft.documents = draft.documents.map((item) => (item.id === updated.id ? updated : item));
    });
  }

  async function deleteAnnotationById(id: string) {
    const annotation = activeAnnotations.find((item) => item.id === id);
    const linkedResultId = annotation ? explanationResultId(annotation) : "";
    try {
      await deleteAnnotation(id);
      if (linkedResultId) {
        await deleteAiResults([linkedResultId]);
      }
      patchState((draft) => {
        draft.annotations = draft.annotations.filter((item) => item.id !== id);
        if (linkedResultId) {
          draft.aiResults = draft.aiResults.filter((item) => item.id !== linkedResultId);
        }
      });
      if (linkedResultId && floatingResultId === linkedResultId) {
        setFloatingResultId(null);
      }
      if (linkedResultId) {
        showToast(ui.deletedExplanation);
      }
    } catch (error) {
      showToast(`${ui.couldNotDeleteAnnotationPrefix}: ${String(error)}`, "error");
    }
  }

  async function deleteAllActiveAnnotations() {
    if (!activeDocument || activeAnnotations.length === 0) {
      showToast(ui.noHighlightsToDelete);
      return;
    }
    const confirmed = window.confirm(`${ui.deleteAllHighlightsConfirm} (${activeAnnotations.length})`);
    if (!confirmed) {
      return;
    }
    const annotationIds = new Set(activeAnnotations.map((annotation) => annotation.id));
    const linkedResultIds = activeAnnotations.map(explanationResultId).filter(Boolean);
    try {
      await Promise.all(activeAnnotations.map((annotation) => deleteAnnotation(annotation.id)));
      if (linkedResultIds.length > 0) {
        await deleteAiResults(linkedResultIds);
      }
      patchState((draft) => {
        draft.annotations = draft.annotations.filter((annotation) => !annotationIds.has(annotation.id));
        draft.comments = draft.comments.filter((comment) => !annotationIds.has(comment.annotationId));
        draft.settings.autoHighlight = "false";
        if (linkedResultIds.length > 0) {
          const resultIds = new Set(linkedResultIds);
          draft.aiResults = draft.aiResults.filter((result) => !resultIds.has(result.id));
        }
      });
      if (state.settings.autoHighlight === "true") {
        void setSetting("autoHighlight", "false");
      }
      if (floatingResultId && linkedResultIds.includes(floatingResultId)) {
        setFloatingResultId(null);
      }
      showToast(`${annotationIds.size}${uiLanguage === "ko" ? "" : " "}${ui.deletedHighlightsSuffix} ${ui.autoHighlightTurnedOff}`);
    } catch (error) {
      showToast(`${ui.couldNotDeleteHighlightsPrefix}: ${String(error)}`, "error");
    }
  }

  async function deleteExplanationResult(result: AiResultRecord) {
    const linkedAnnotations = activeAnnotations.filter((annotation) => explanationResultId(annotation) === result.id);
    const linkedAnnotationIds = new Set(linkedAnnotations.map((annotation) => annotation.id));
    try {
      await Promise.all(linkedAnnotations.map((annotation) => deleteAnnotation(annotation.id)));
      await deleteAiResults([result.id]);
      patchState((draft) => {
        draft.annotations = draft.annotations.filter((annotation) => !linkedAnnotationIds.has(annotation.id));
        draft.aiResults = draft.aiResults.filter((item) => item.id !== result.id);
      });
      if (floatingResultId === result.id) {
        setFloatingResultId(null);
      }
      showToast(ui.deletedExplanation);
    } catch (error) {
      showToast(`${ui.couldNotDeleteExplanationPrefix}: ${String(error)}`, "error");
    }
  }

  function openExplanation(annotation: AnnotationRecord) {
    const resultId = explanationResultId(annotation);
    const result =
      activeAiResults.find((item) => item.id === resultId) ??
      activeAiResults.find(
        (item) => item.taskType.toString() === "explainText" && normalizeForMatch(item.inputText).includes(normalizeForMatch(annotation.text).slice(0, 120)),
      );
    if (!result) {
      showToast(ui.noSavedExplanation, "error");
      return;
    }
    setFloatingResultId(result.id);
    setRightPanelOpen(true);
    setActivePanel("ai");
  }

  async function openLinkPreview(target: PdfLinkPreviewTarget) {
    if (target.kind === "external" && target.url) {
      const url = target.url;
      const existingSummary = activeAiResults.find(
        (result) => result.taskType.toString() === "externalLinkSummary" && result.inputText.includes(url),
      );
      setLinkPreview({
        kind: "external",
        sourcePage: target.sourcePage,
        title: target.title || hostFromUrl(target.url),
        url,
        summary: existingSummary ? getReadableAiOutput(existingSummary, ui) : externalPreviewSummary(url, ui),
      });
      return;
    }
    if (!pdfDocument) {
      return;
    }
    setLinkPreviewLoading(true);
    try {
      const targetPage = target.targetPage ?? (await resolvePdfDestinationPage(pdfDocument, target.dest));
      if (!targetPage) {
        showToast(ui.previewTargetNotFound, "error");
        return;
      }
      const requiresRegionPreview = isRegionPreviewKind(target.previewKind);
      const regionImageDataUrl = requiresRegionPreview
        ? await renderPdfPageRegionDataUrl(pdfDocument, targetPage, target).catch(() => null)
        : null;
      if (requiresRegionPreview && !regionImageDataUrl) {
        showToast(ui.referencePreviewNotFound, "error");
        return;
      }
      const imageDataUrl = regionImageDataUrl ?? (await renderPdfPageDataUrl(pdfDocument, targetPage, 1.35));
      setLinkPreview({
        kind: "internal",
        sourcePage: target.sourcePage,
        targetPage,
        title: target.previewKind === "link" && target.title === "PDF link" ? `${ui.page} ${targetPage}` : target.title || `${ui.page} ${targetPage}`,
        imageDataUrl,
        previewMode: regionImageDataUrl ? "region" : "page",
        previewKind: target.previewKind,
        targetText: target.targetText,
        excerpt: target.excerpt,
        referenceText: target.referenceText,
      });
    } catch (error) {
      showToast(`${ui.previewFailedPrefix}: ${String(error)}`, "error");
    } finally {
      setLinkPreviewLoading(false);
    }
  }

  function goToLinkPreviewTarget(preview: LinkPreviewState) {
    if (preview.kind === "external") {
      if (!openExternalUrl(preview.url)) {
        showToast(ui.invalidExternalUrl, "error");
      }
      return;
    }
    goToPage(preview.targetPage);
    setLinkPreview(null);
  }

  async function summarizeLinkPreview(preview: LinkPreviewState) {
    if (preview.kind !== "external") {
      return;
    }
    const queued = await queueTask(
      "externalLinkSummary",
      { url: preview.url, reference: preview.url },
      { silent: false, keepPanel: true },
    );
    if (!queued) {
      return;
    }
    setLinkPreview((current) =>
      current?.kind === "external" && current.url === preview.url
        ? { ...current, summary: getReadableAiOutput(queued, ui) }
        : current,
    );
  }

  async function saveNote(markdown: string) {
    if (!activeDocument || !activeNote) {
      return;
    }
    const note = await upsertNote({ ...activeNote, markdown, updatedAt: nowIso() });
    patchState((draft) => {
      draft.notes = [note, ...draft.notes.filter((item) => item.id !== note.id)];
    });
    showToast(ui.noteSaved);
  }

  async function deleteActiveNote() {
    if (!activeNote) {
      return;
    }
    await deleteNote(activeNote.id);
    patchState((draft) => {
      draft.notes = draft.notes.filter((item) => item.id !== activeNote.id);
    });
    showToast(ui.noteDeleted);
  }

  async function createFolder(parentId = folderFilter === "all" ? "root" : folderFilter, nameOverride?: string) {
    const name = (nameOverride ?? newFolderName).trim();
    if (!name) {
      return;
    }
    const folder: FolderRecord = {
      id: makeId("folder"),
      parentId: parentId === "all" ? "root" : parentId,
      name,
      createdAt: nowIso(),
    };
    const saved = await upsertFolder(folder);
    patchState((draft) => {
      draft.folders = [saved, ...draft.folders.filter((item) => item.id !== saved.id)];
    });
    setNewFolderName("");
    setFolderFilter(saved.id);
  }

  async function moveActiveDocument(folderId: string) {
    if (!activeDocument) {
      return;
    }
    await updateMetadata("folderId", folderId);
    setFolderFilter(folderId);
  }

  async function renameFolder(folder: FolderRecord) {
    if (folder.id === "root") {
      return;
    }
    const name = window.prompt(ui.folderNamePrompt, folder.name)?.trim();
    if (!name || name === folder.name) {
      return;
    }
    const saved = await upsertFolder({ ...folder, name });
    patchState((draft) => {
      draft.folders = [saved, ...draft.folders.filter((item) => item.id !== saved.id)];
    });
  }

  async function createChildFolder(parentId: string) {
    const name = window.prompt(ui.childFolderNamePrompt)?.trim();
    if (!name) {
      return;
    }
    await createFolder(parentId, name);
  }

  async function deleteFolderTree(folder: FolderRecord) {
    if (folder.id === "root") {
      showToast(ui.cannotDeleteRootFolder, "error");
      return;
    }
    const ids = folderDescendantIds(state.folders, folder.id);
    const targetFolderId = folder.parentId || "root";
    const documentCount = state.documents.filter((document) => ids.has(documentFolderId(document))).length;
    const confirmed = window.confirm(
      `"${folder.name}" ${ui.deleteFolderConfirm} ${folderPathLabel(state.folders, targetFolderId, ui)} (${documentCount})`,
    );
    if (!confirmed) {
      return;
    }
    await deleteFolders([...ids], targetFolderId);
    const now = nowIso();
    patchState((draft) => {
      draft.folders = draft.folders.filter((item) => !ids.has(item.id));
      draft.documents = draft.documents.map((document) =>
        ids.has(documentFolderId(document))
          ? { ...document, folderId: targetFolderId, updatedAt: now }
          : document,
      );
    });
    setSelectedDocumentIds([]);
    if (ids.has(folderFilter)) {
      setFolderFilter(targetFolderId);
    }
  }

  async function moveDocumentsToFolder(documentIds: string[], folderId: string) {
    const targetFolderId = folderId === "all" ? "root" : folderId;
    const ids = new Set(documentIds);
    const documents = state.documents.filter((document) => ids.has(document.id));
    if (documents.length === 0) {
      return;
    }
    const now = nowIso();
    const savedDocuments = await Promise.all(
      documents.map((document) => updateDocument({ ...document, folderId: targetFolderId, updatedAt: now })),
    );
    patchState((draft) => {
      draft.documents = draft.documents.map((document) => savedDocuments.find((saved) => saved.id === document.id) ?? document);
    });
    setSelectedDocumentIds([]);
    setFolderFilter(targetFolderId);
  }

  async function deleteDocumentsFromLibrary(documentIds: string[]) {
    const ids = new Set(documentIds);
    if (ids.size === 0) {
      return;
    }
    const confirmed = window.confirm(`${ui.deleteDocumentsConfirm} (${ids.size})`);
    if (!confirmed) {
      return;
    }
    for (const id of ids) {
      await deleteDocument(id);
    }
    patchState((draft) => {
      draft.documents = draft.documents.filter((item) => !ids.has(item.id));
      draft.pages = draft.pages.filter((item) => !ids.has(item.documentId));
      draft.annotations = draft.annotations.filter((item) => !ids.has(item.documentId));
      draft.comments = draft.comments.filter((item) => !ids.has(item.documentId));
      draft.notes = draft.notes.filter((item) => !ids.has(item.documentId));
      draft.aiResults = draft.aiResults.filter((item) => !ids.has(item.documentId));
      draft.citationCards = draft.citationCards.filter((item) => !ids.has(item.documentId));
    });
    if (activeDocumentId && ids.has(activeDocumentId)) {
      setActiveDocumentId(null);
      setPdfDocument(null);
      setLoadedBytes(null);
      setPageImages({});
      setPdfOutlineRows([]);
      setPageOutlineAnchors({});
      setActiveOutlineId(null);
    }
    setSelectedDocumentIds([]);
  }

  function toggleLibraryDocumentSelection(id: string, selected: boolean) {
    setSelectedDocumentIds((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return [...next];
    });
  }

  async function exportJson() {
    if (!activeDocument) {
      return;
    }
    const bundle = await exportDocumentJson(activeDocument.id);
    downloadText(`${activeDocument.title || "paper-pilot-export"}.json`, JSON.stringify(bundle, null, 2));
  }

  async function exportZip() {
    if (!activeDocument) {
      return;
    }
    try {
      const path = await exportDocumentZip(activeDocument.id);
      showToast(`${ui.zipExportWrittenPrefix} ${path}`);
    } catch (error) {
      showToast(String(error), "error");
    }
  }

  async function shareAnnotatedFile() {
    if (!activeDocument) {
      showToast(ui.openDocumentFirst, "error");
      return;
    }
    if (!pdfDocument && Object.keys(pageImages).length === 0) {
      showToast(ui.renderPdfFirstForShare, "error");
      return;
    }
    setIsBusy(true);
    try {
      const pages = (await ensureActivePages()).sort((a, b) => a.pageNumber - b.pageNumber);
      const sharePages: SharePdfPage[] = [];
      for (const page of pages) {
        const pageImage =
          pdfDocument ? await renderPdfPageDataUrl(pdfDocument, page.pageNumber) : pageImages[page.pageNumber];
        if (!pageImage) {
          throw new Error(`Page ${page.pageNumber} image is not ready.`);
        }
        sharePages.push(await createTranslatedSharePage(pageImage, page, activeAiResults, translationLanguageName, ui));
      }
      const pdfBytes = buildPdfFromJpegPages(sharePages);
      const fileName = `${safeFileName(activeDocument.title || activeDocument.fileName)}-translated.pdf`;
      if (isTauriRuntime()) {
        const savedPath = await savePdfFile(fileName, pdfBytes);
        if (savedPath) {
          showToast(`${ui.pdfSavedPrefix} ${savedPath}`);
        } else {
          showToast(ui.pdfExportCancelled);
        }
        return;
      }
      const pickerResult = await saveBytesWithBrowserPicker(fileName, pdfBytes, "application/pdf");
      if (pickerResult === "saved") {
        showToast(ui.translatedPdfSaved);
        return;
      }
      if (pickerResult === "cancelled") {
        showToast(ui.pdfExportCancelled);
        return;
      }
      downloadBytes(fileName, pdfBytes, "application/pdf");
      showToast(ui.translatedPdfDownloaded);
    } catch (error) {
      showToast(`${ui.shareFileFailedPrefix}: ${String(error)}`, "error");
    } finally {
      setIsBusy(false);
    }
  }

  async function copyText(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    showToast(`${label} ${ui.copiedSuffix}.`);
  }

  async function resetWorkspace() {
    const confirmed = window.confirm(ui.libraryResetConfirm);
    if (!confirmed) {
      return;
    }
    try {
      const result = await resetWorkspaceFiles(bridgePath);
      const settings = { ...initialState.settings, ...result.state.settings };
      settings.uiLanguage = settings.uiLanguage === "en" ? "en" : "ko";
      settings.language = settings.uiLanguage;
      settings.translationLanguage = translationLanguageOption(settings.translationLanguage).value;
      settings.aiProvider = normalizeAiProviderKind(settings.aiProvider);
      settings.codexModel = settings.codexModel || (settings.aiProvider === "codex-cli" ? settings.aiModel || "" : "");
      settings.codexReasoningEffort = selectedCodexReasoningEffort(settings);
      settings.claudeModel = settings.claudeModel || (settings.aiProvider === "claude-code" ? settings.aiModel || "" : "");
      settings.autoHighlight = "false";
      settings.wordMeaningLookupEnabled = wordMeaningLookupEnabled(settings) ? "true" : "false";
      settings.aiModel = selectedAiModel(settings);
      setState({ ...initialState, ...result.state, settings });
      setMode("library");
      setActiveDocumentId(null);
      setPdfDocument(null);
      setLoadedBytes(null);
      setPageImages({});
      setPdfOutlineRows([]);
      setPageOutlineAnchors({});
      setActiveOutlineId(null);
      setChatDraft("");
      setSelectionToolbar(null);
      showToast(
        result.skippedPaths.length
          ? `${ui.libraryResetSkippedPrefix}\n${result.skippedPaths.join("\n")}`
          : ui.libraryResetDone,
      );
    } catch (error) {
      showToast(`${ui.libraryResetFailedPrefix}: ${String(error)}`, "error");
    }
  }

  const filteredDocuments = useMemo(() => {
    const query = libraryQuery.trim().toLowerCase();
    const visibleFolderIds = folderFilter === "all" ? null : folderDescendantIds(state.folders, folderFilter);
    return state.documents.filter((document) => {
      const inFolder = !visibleFolderIds || visibleFolderIds.has(documentFolderId(document));
      const matches =
        !query ||
        [document.title, document.authors, document.year, document.fileName, document.abstractText]
          .join(" ")
          .toLowerCase()
          .includes(query);
      return inFolder && matches;
    });
  }, [folderFilter, libraryQuery, state.documents, state.folders]);

  const pageMatches = useMemo(() => {
    if (!searchTerm.trim()) {
      return [];
    }
    const query = searchTerm.toLowerCase();
    return activePages.filter((page) => page.text.toLowerCase().includes(query)).map((page) => page.pageNumber);
  }, [activePages, searchTerm]);

  function toggleSettingsMode() {
    setWordPopup(null);
    setMode((current) => (current === "settings" ? (activeDocument ? "reader" : "library") : "settings"));
  }

  function openLibraryMode() {
    setWordPopup(null);
    setMode("library");
  }

  const floatingResultIsTranslation = Boolean(
    floatingResult && ["translateText", "translatePage"].includes(floatingResult.taskType.toString()),
  );

  return (
    <UiStringsContext.Provider value={ui}>
    <div
      className="app-shell"
      data-theme={state.settings.theme}
      lang={uiLanguage}
      style={{ "--font-scale": state.settings.fontScale || "1" } as React.CSSProperties}
      onDragOver={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragLeave={() => setDragActive(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        void handleFiles(event.dataTransfer.files);
      }}
    >
      <main className="workspace">
        <TopToolbar
          ui={ui}
          mode={mode}
          document={activeDocument}
          zoom={zoom}
          pageCursor={pageCursor}
          pageCount={pdfDocument?.numPages ?? activeDocument?.pageCount ?? 0}
          searchTerm={searchTerm}
          busy={isBusy}
          outlineOpen={outlineOpen}
          shareReady={Boolean(activeDocument && (pdfDocument || Object.keys(pageImages).length > 0))}
          onPickFile={() => fileInputRef.current?.click()}
          onOpenLibrary={openLibraryMode}
          onOpenSettings={toggleSettingsMode}
          onZoomIn={() => commitZoom(zoom + 0.1)}
          onZoomOut={() => commitZoom(zoom - 0.1)}
          onPageChange={(page) => goToPage(page)}
          onSearch={setSearchTerm}
          onTogglePanel={() => setRightPanelOpen((value) => !value)}
          onToggleTranslationPanel={() => setTranslationPanelOpen((value) => !value)}
          onZoomChange={commitZoom}
          onShowOutline={() => {
            if (mode === "reader") {
              setOutlineOpen((value) => !value);
            } else {
              setMode(activeDocument ? "reader" : mode);
              setOutlineOpen(true);
            }
            setOutlineCompact(false);
          }}
          onStartRegionExplain={() => {
            setRegionMode(true);
            showToast(ui.dragRegionPrompt);
          }}
          onTranslatePage={() => {
            const page = activePages.find((item) => item.pageNumber === pageCursor);
            if (page) {
              void refreshTranslationForPage(page);
            }
          }}
          onToggleAutoTranslate={() => {
            const next = state.settings.autoTranslate === "true" ? "false" : "true";
            patchState((draft) => {
              draft.settings.autoTranslate = next;
            });
            void setSetting("autoTranslate", next);
          }}
          onShareFile={() => void shareAnnotatedFile()}
          autoTranslate={state.settings.autoTranslate === "true"}
          translationPanelOpen={translationPanelOpen}
        />

        <input
          ref={fileInputRef}
          className="hidden-input"
          type="file"
          accept="application/pdf,.pdf"
          multiple
          onChange={(event) => event.target.files && void handleFiles(event.target.files)}
        />

        {mode === "library" && (
          <LibraryManagerView
            state={state}
            documents={filteredDocuments}
            libraryQuery={libraryQuery}
            folderFilter={folderFilter}
            newFolderName={newFolderName}
            selectedDocumentIds={selectedDocumentIds}
            onLibraryQuery={setLibraryQuery}
            onFolderFilter={setFolderFilter}
            onNewFolderName={setNewFolderName}
            onCreateFolder={(parentId, name) => void createFolder(parentId, name)}
            onCreateChildFolder={(parentId) => void createChildFolder(parentId)}
            onRenameFolder={(folder) => void renameFolder(folder)}
            onDeleteFolder={(folder) => void deleteFolderTree(folder)}
            onPickFile={() => fileInputRef.current?.click()}
            onOpen={(document) => void loadPdfBytes(document)}
            onSelect={(id) => setActiveDocumentId(id)}
            onToggleSelect={toggleLibraryDocumentSelection}
            onSelectVisible={(ids) => setSelectedDocumentIds(ids)}
            onMoveDocuments={(ids, folderId) => void moveDocumentsToFolder(ids, folderId)}
            onDeleteDocuments={(ids) => void deleteDocumentsFromLibrary(ids)}
            onToggleBookmark={(document) => void toggleDocumentBookmark(document)}
          />
        )}

        {mode === "reader" && (
          <section
            className={[
              "reader-grid",
              !outlineOpen ? "outline-closed" : "",
              !rightPanelOpen ? "panel-closed" : "",
              !translationPanelOpen ? "translation-closed" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={readerGridStyle}
          >
            <ReaderRail
              ui={ui}
              outlineOpen={outlineOpen}
              translationPanelOpen={translationPanelOpen}
              rightPanelOpen={rightPanelOpen}
              onShowOutline={() => {
                setOutlineOpen((value) => !value);
                setOutlineCompact(false);
              }}
              onToggleTranslationPanel={() => setTranslationPanelOpen((value) => !value)}
              onTogglePanel={() => setRightPanelOpen((value) => !value)}
            />
            {outlineOpen && (
              <ReaderOutline
                compact={outlineCompact}
                document={activeDocument}
                pages={activePages}
                rows={activeOutlineRows}
                pageCursor={pageCursor}
                activeRowId={activeOutlineId}
                onCompact={setOutlineCompact}
                onClose={() => setOutlineOpen(false)}
                onResizeStart={(event) => startLayoutResize("outline", event)}
                onGoToRow={goToOutlineRow}
              />
            )}
            {translationPanelOpen && (
              <TranslationSidecar
                ui={ui}
                translationLanguageName={translationLanguageName}
                page={pageCursor}
                pageCount={pdfDocument?.numPages ?? activeDocument?.pageCount ?? 0}
                units={currentTranslationUnits}
                selectedSentenceId={selectedSentenceId}
                pending={Boolean(translationResultForPage(activeAiResults, currentPage, translationLanguageName)?.status === "pending")}
                autoTranslate={state.settings.autoTranslate === "true"}
                onSelectSentence={selectSentenceAndScroll}
                onRefresh={() => currentPage && void refreshTranslationForPage(currentPage)}
                onTranslatePage={() => currentPage && void refreshTranslationForPage(currentPage)}
                onResizeStart={(event) => startLayoutResize("translation", event)}
                onClose={() => setTranslationPanelOpen(false)}
              />
            )}
            <div
              ref={readerRef}
              className={[
                "pdf-stage",
                regionMode ? "region-mode" : "",
                markupTool.kind === "erase" ? "highlight-erase-mode" : "",
                markupTool.kind === "highlight" ? "highlight-paint-mode" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onMouseDown={handleRegionMouseDown}
              onMouseMove={handleRegionMouseMove}
              onMouseUp={(event) => void finishRegionExplain(event)}
              onScroll={(event) => {
                scheduleHorizontalScrollSave(event.currentTarget.scrollLeft);
                scheduleReaderCursorSync(event.currentTarget);
              }}
            >
              <ReaderActionPalette
                ui={ui}
                markupTool={markupTool}
                autoTranslate={state.settings.autoTranslate === "true"}
                wordMeaningLookupEnabled={wordMeaningLookupEnabled(state.settings)}
                wordListCount={activeDocumentWordList.length}
                missingWordCount={missingWordCount}
                onSelectHighlightColor={(color) =>
                  setMarkupTool((current) =>
                    current.kind === "highlight" && current.color === color ? { kind: "none" } : { kind: "highlight", color },
                  )
                }
                onSelectEraser={() =>
                  setMarkupTool((current) => (current.kind === "erase" ? { kind: "none" } : { kind: "erase" }))
                }
                onStartRegionExplain={() => {
                  setRegionMode(true);
                  showToast(ui.dragRegionPrompt);
                }}
                onToggleAutoTranslate={() => {
                  const next = state.settings.autoTranslate === "true" ? "false" : "true";
                  patchState((draft) => {
                    draft.settings.autoTranslate = next;
                  });
                  void setSetting("autoTranslate", next);
                }}
                onToggleWordMeaningLookup={() => {
                  const next = wordMeaningLookupEnabled(state.settings) ? "false" : "true";
                  patchState((draft) => {
                    draft.settings[wordMeaningLookupEnabledSettingKey] = next;
                  });
                  if (next === "false") {
                    setWordPopup(null);
                  }
                  void setSetting(wordMeaningLookupEnabledSettingKey, next);
                }}
                onBuildWordMeanings={() => void queueMissingWordMeanings()}
              />
              {!activeDocument && <EmptyReader onPickFile={() => fileInputRef.current?.click()} />}
              {activeDocument && !pdfDocument && (
                <EmptyReader
                  label={ui.openStoredPdf}
                  hint={ui.selectedDocumentNeedsLoad}
                  onPickFile={() => void loadPdfBytes(activeDocument)}
                />
              )}
              {pdfDocument &&
                activeDocument &&
                Array.from({ length: pdfDocument.numPages }, (_, index) => index + 1).map((pageNumber) => (
                  <PdfPageView
                    key={`${activeDocument.id}-${pageNumber}-${zoom}`}
                    pdf={pdfDocument}
                    documentId={activeDocument.id}
                    pageNumber={pageNumber}
                    zoom={zoom}
                    searchTerm={searchTerm}
                    referencePages={activePages}
                    annotations={activeAnnotations.filter((annotation) => annotation.page === pageNumber)}
                    hoverSource={hoverSource}
                    sentenceUnits={sentenceUnitsForPage(activePages.find((page) => page.pageNumber === pageNumber))}
                    selectedSentenceIds={selectedSentenceIds}
                    highlightEraseActive={markupTool.kind === "erase"}
                    onWordSelect={openWordMeaningPopup}
                    regionDrag={regionDrag}
                    onTextReady={createPageText}
                    onOutlineReady={rememberOutlineAnchors}
                    onImageReady={rememberPageImage}
                    onOpenExplanation={openExplanation}
                    onDeleteAnnotation={(id) => void deleteAnnotationById(id)}
                    onPreviewLink={(target) => void openLinkPreview(target)}
                  />
                ))}
            </div>
            {rightPanelOpen && (
              <RightPanel
                tab={activePanel}
                setTab={setActivePanel}
                document={activeDocument}
                pages={activePages}
                annotations={activeAnnotations}
                aiResults={activeAiResults}
                citations={activeCitations}
                note={activeNote}
                settings={state.settings}
                outlineRows={activeOutlineRows}
                searchMatches={pageMatches}
                onQueueTask={(type, payload) => void queueTask(type, payload)}
                onRunBridge={() => void runPendingBridgeWorkers()}
                onPollBridge={() => void pollBridge()}
                onStartRegionExplain={() => {
                  setRegionMode(true);
                  showToast(ui.dragRegionPrompt);
                }}
                onUpdateAnnotation={(annotation) =>
                  void upsertAnnotation(annotation).then((saved) =>
                    patchState((draft) => {
                      draft.annotations = [saved, ...draft.annotations.filter((item) => item.id !== saved.id)];
                    }),
                  )
                }
                onDeleteAnnotation={(id) =>
                  void deleteAnnotationById(id)
                }
                onDeleteAllAnnotations={() => void deleteAllActiveAnnotations()}
                onDeleteExplanation={(result) => void deleteExplanationResult(result)}
                onGoToPage={goToPage}
                onExtractCitations={() => void extractCitationCards()}
                onResolveCitationLinks={() => void resolveCitationLinks()}
                onDeleteCitation={(id) =>
                  void deleteCitationCard(id).then(() =>
                    patchState((draft) => {
                      draft.citationCards = draft.citationCards.filter((item) => item.id !== id);
                    }),
                  )
                }
                onSaveCitation={(card) =>
                  void upsertCitationCard(card).then((saved) =>
                    patchState((draft) => {
                      draft.citationCards = [saved, ...draft.citationCards.filter((item) => item.id !== saved.id)];
                    }),
                  )
                }
                onSaveNote={(markdown) => saveNote(markdown)}
                onDeleteNote={() => deleteActiveNote()}
                onMetadata={updateMetadata}
                onMoveFolder={(folderId) => void moveActiveDocument(folderId)}
                folders={state.folders}
                onJsonExport={() => void exportJson()}
                onZipExport={() => void exportZip()}
                onCopy={copyText}
                onHoverSource={setHoverSource}
                chatDraft={chatDraft}
                setChatDraft={setChatDraft}
                assistantMode={assistantMode}
                setAssistantMode={setAssistantMode}
                pageCursor={pageCursor}
                pageImages={pageImages}
                onResizeStart={(event) => startLayoutResize("rightPanel", event)}
                onClose={() => setRightPanelOpen(false)}
              />
            )}
          </section>
        )}

        {mode === "settings" && (
          <SettingsView
            ui={ui}
            uiLanguage={uiLanguage}
            settings={state.settings}
            agentStatuses={agentStatuses}
            runtime={isTauriRuntime() ? "Tauri desktop" : "Browser preview"}
            onResetWorkspace={() => void resetWorkspace()}
            onChange={(key, value) => {
              patchState((draft) => {
                draft.settings[key] = value;
              });
              void setSetting(key, value);
            }}
          />
        )}
      </main>

      {selectionToolbar && activeDocument && (
        <SelectionToolbarView
          toolbar={selectionToolbar}
          onExplain={() => void explainSelection()}
          onTranslate={() => void queueTask("translateText", { text: selectionToolbar.text, page: selectionToolbar.page })}
          onComment={() => void addCommentFromSelection()}
          onChat={() => {
            setChatDraft(selectionToolbar.text);
            setActivePanel("ai");
          }}
          onCopyLatex={() => void copyText(selectionToolbar.text, "LaTeX/source text")}
          onHighlight={(color) => void createManualHighlight(color)}
        />
      )}

      {floatingResult && (!floatingResultIsTranslation || translationPanelOpen) && (
        <FloatingAiCard
          result={floatingResult}
          onClose={() => setFloatingResultId(null)}
          onCopy={() => void copyText(getReadableAiOutput(floatingResult, ui), taskTitle(floatingResult.taskType.toString(), ui))}
          onDelete={(result) => void deleteExplanationResult(result)}
        />
      )}

      {wordPopup && (
        <WordMeaningPopup
          ui={ui}
          popup={wordPopup}
          entries={displayWordMeaningEntries(wordMeaningMap[normalizeWordKey(wordPopup.word)] ?? [])}
          loading={wordLookupLoadingKey === normalizeWordKey(wordPopup.word)}
          onClose={() => setWordPopup(null)}
          onAdjust={() => void queueAdjustedWordMeaning(wordPopup)}
        />
      )}

      {(linkPreview || linkPreviewLoading) && (
        <LinkPreviewModal
          preview={linkPreview}
          loading={linkPreviewLoading}
          onClose={() => {
            setLinkPreview(null);
            setLinkPreviewLoading(false);
          }}
          onGo={(preview) => goToLinkPreviewTarget(preview)}
          onSummarize={(preview) => void summarizeLinkPreview(preview)}
        />
      )}

      {dragActive && (
        <div className="drop-overlay">
          <Upload size={32} />
          <span>{ui.dropPdfsOverlay}</span>
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
          <span>{toast.message}</span>
          <button title={ui.dismissMessage} onClick={() => setToast(null)}>
            x
          </button>
        </div>
      )}
      {regionDrag && (
        <div className="region-readout">
          {ui.regionSizeLabel} {Math.round(regionDrag.width)} x {Math.round(regionDrag.height)}
        </div>
      )}
    </div>
    </UiStringsContext.Provider>
  );
}

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
  shareReady: boolean;
  onPickFile: () => void;
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

function ReaderOutline(props: {
  compact: boolean;
  document: DocumentRecord | null;
  pages: PageRecord[];
  rows: OutlineRow[];
  pageCursor: number;
  activeRowId: string | null;
  onCompact: (value: boolean) => void;
  onClose: () => void;
  onResizeStart: (event: React.PointerEvent) => void;
  onGoToRow: (row: OutlineRow) => void;
}) {
  const ui = useUiStrings();
  const rows = props.rows;
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
              {rows.some((row) => row.source === "ai")
                ? ` · ${ui.aiOutline}`
                : rows.some((row) => row.source === "pending")
                  ? ` · ${ui.aiOutlinePending}`
                  : ""}
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
              <small>User</small>
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

function ReaderRail(props: {
  ui: UiStrings;
  outlineOpen: boolean;
  translationPanelOpen: boolean;
  rightPanelOpen: boolean;
  onShowOutline: () => void;
  onToggleTranslationPanel: () => void;
  onTogglePanel: () => void;
}) {
  return (
    <nav className="reader-rail" aria-label="Reader workspace">
      <button className="rail-mark" title="Paper Pilot" data-tooltip="Paper Pilot" aria-label="Paper Pilot">
        <BookOpen size={18} />
      </button>
      <div className="rail-group">
        <button
          className={props.outlineOpen ? "active" : ""}
          title={props.outlineOpen ? props.ui.closeOutline : props.ui.openOutline}
          data-tooltip={props.outlineOpen ? props.ui.closeOutline : props.ui.openOutline}
          aria-label={props.outlineOpen ? props.ui.closeOutline : props.ui.openOutline}
          onClick={props.onShowOutline}
        >
          <ListTree size={18} />
        </button>
        <button
          className={props.translationPanelOpen ? "active" : ""}
          title={props.translationPanelOpen ? props.ui.closeTranslationPanel : props.ui.openTranslationPanel}
          data-tooltip={props.translationPanelOpen ? props.ui.closeTranslationPanel : props.ui.openTranslationPanel}
          aria-label={props.translationPanelOpen ? props.ui.closeTranslationPanel : props.ui.openTranslationPanel}
          onClick={props.onToggleTranslationPanel}
        >
          <Languages size={18} />
        </button>
        <button
          className={props.rightPanelOpen ? "active" : ""}
          title={props.ui.panel}
          data-tooltip={props.ui.panel}
          aria-label={props.ui.panel}
          onClick={props.onTogglePanel}
        >
          <MessageSquareText size={18} />
        </button>
      </div>
    </nav>
  );
}

function ReaderActionPalette(props: {
  ui: UiStrings;
  markupTool: ReaderMarkupTool;
  autoTranslate: boolean;
  wordMeaningLookupEnabled: boolean;
  wordListCount: number;
  missingWordCount: number;
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

function WordMeaningPopup(props: {
  ui: UiStrings;
  popup: WordPopup;
  entries: WordMeaningEntry[];
  loading: boolean;
  onClose: () => void;
  onAdjust: () => void;
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
            <button type="button" onClick={props.onAdjust}>
              <Sparkles size={14} />
              <span>{props.ui.adjustWordMeaning}</span>
            </button>
          </div>
        )}
        {props.entries.map((entry) => (
          <article key={entry.id} className="word-meaning-row">
            <div>
              <p>{entry.meaning}</p>
            </div>
            <button type="button" title={props.ui.adjustWordMeaning} onClick={props.onAdjust}>
              <Sparkles size={13} />
              <span>{props.ui.adjustWordMeaning}</span>
            </button>
          </article>
        ))}
      </div>
    </aside>
  );
}

function TopToolbar(props: TopToolbarProps) {
  const title =
    props.mode === "reader"
      ? props.document?.title || "Paper Pilot"
      : props.mode === "library"
        ? props.ui.library
        : props.ui.settings;
  const zoomPercent = Math.round(props.zoom * 100);
  const zoomOptions = [80, 100, 105, 113, 125, 150, 175];
  const resolvedZoomOptions = zoomOptions.includes(zoomPercent)
    ? zoomOptions
    : [...zoomOptions, zoomPercent].sort((a, b) => a - b);
  return (
    <header className="top-toolbar">
      <div className="toolbar-document">
        <button title={props.ui.library} data-tooltip={props.ui.library} aria-label={props.ui.library} className={props.mode === "library" ? "toolbar-icon active" : "toolbar-icon"} onClick={props.onOpenLibrary}>
          <Library size={17} />
        </button>
        <div>
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
        <button title={props.ui.addPdf} data-tooltip={props.ui.addPdf} aria-label={props.ui.addPdf} className="toolbar-icon" onClick={props.onPickFile}>
          <Upload size={17} />
        </button>
        <button title={props.ui.settings} data-tooltip={props.ui.settings} aria-label={props.ui.settings} className={props.mode === "settings" ? "toolbar-icon active" : "toolbar-icon"} onClick={props.onOpenSettings}>
          <Settings size={17} />
        </button>
        {props.busy && <span className="busy-pill">{props.ui.working}</span>}
      </div>
    </header>
  );
}

function AutoHighlightMenu(props: { enabled: boolean; onToggle: () => void; onRun: () => void }) {
  const ui = useUiStrings();
  return (
    <div className="auto-highlight-menu">
      <div className="menu-title-row">
        <strong>{ui.autoHighlightCompact}</strong>
        <button
          className={props.enabled ? "switch-button" : "switch-button off"}
          type="button"
          onClick={props.onToggle}
          aria-label={ui.autoHighlightToggle}
        >
          {props.enabled ? "ON" : "OFF"}
        </button>
      </div>
      <div className="palette-list">
        {highlightPalettes.map((palette, index) => (
          <label key={palette.name} className="palette-option">
            <input type="radio" name="highlight-palette" defaultChecked={index === 0} />
            <span className="palette-swatches">
              {palette.colors.map((color) => (
                <i key={color} style={{ background: color }} />
              ))}
            </span>
            <span>{palette.name}</span>
          </label>
        ))}
      </div>
      <p>{ui.autoHighlightCurrentPageOnly}</p>
      <div className="palette-tags">
        <span style={{ borderColor: "#d68b6b" }}>{ui.originality}</span>
        <span style={{ borderColor: "#65bda9" }}>{ui.method}</span>
        <span style={{ borderColor: "#8a75ac" }}>{ui.result}</span>
      </div>
      <button className="wide-command compact" type="button" onClick={props.onRun}>
        <Sparkles size={15} />
        <span>{ui.autoHighlightCurrentPage}</span>
      </button>
    </div>
  );
}

type LibraryViewProps = {
  state: AppStateRecord;
  documents: DocumentRecord[];
  libraryQuery: string;
  folderFilter: string;
  newFolderName: string;
  onLibraryQuery: (value: string) => void;
  onFolderFilter: (value: string) => void;
  onNewFolderName: (value: string) => void;
  onCreateFolder: () => void;
  onPickFile: () => void;
  onOpen: (document: DocumentRecord) => void;
  onSelect: (id: string) => void;
  onToggleBookmark: (document: DocumentRecord) => void;
};

function LibraryView(props: LibraryViewProps) {
  const ui = useUiStrings();
  return (
    <section className="library-view">
      <div className="library-sidebar">
        <div className="upload-target" onClick={props.onPickFile} role="button" tabIndex={0}>
          <Upload size={26} />
          <strong>{ui.addPdf}</strong>
          <span>{ui.addPdfDrop}</span>
        </div>
        <div className="folder-tools">
          <div className="inline-input">
            <input
              value={props.newFolderName}
              onChange={(event) => props.onNewFolderName(event.target.value)}
              placeholder={ui.newFolder}
            />
            <button title={ui.createFolder} className="icon-button" onClick={props.onCreateFolder}>
              <FolderPlus size={17} />
            </button>
          </div>
          <button
            className={props.folderFilter === "all" ? "folder-row active" : "folder-row"}
            onClick={() => props.onFolderFilter("all")}
          >
            <Archive size={16} />
            <span>{ui.allDocuments}</span>
          </button>
          {props.state.folders.map((folder) => (
            <button
              key={folder.id}
              className={props.folderFilter === folder.id ? "folder-row active" : "folder-row"}
              onClick={() => props.onFolderFilter(folder.id)}
            >
              <FolderOpen size={16} />
              <span>{folderDisplayName(folder, ui)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="library-main">
        <div className="library-controls">
          <div className="search-box wide">
            <Search size={16} />
            <input
              value={props.libraryQuery}
              onChange={(event) => props.onLibraryQuery(event.target.value)}
              placeholder={ui.librarySearchPlaceholder}
            />
          </div>
          <span className="muted">{props.documents.length} {ui.documentsSuffix}</span>
        </div>
        <div className="document-grid">
          {props.documents.map((document) => (
            <article
              key={document.id}
              className="document-card"
              title={document.title || document.fileName}
              onClick={() => props.onSelect(document.id)}
              onDoubleClick={() => props.onOpen(document)}
            >
              <div className="document-card-head">
                <FileText size={20} />
                <button
                  className="bookmark-button"
                  title={document.bookmarked ? ui.removeBookmark : ui.bookmark}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onToggleBookmark(document);
                  }}
                >
                  {document.bookmarked ? <BookmarkCheck size={18} /> : <Bookmark size={18} />}
                </button>
              </div>
              <h3>{document.title || document.fileName}</h3>
              <p>{document.authors || ui.noAuthors}</p>
              <div className="document-meta">
                <span>{document.year || ui.unknownYear}</span>
                <span>{document.pageCount || "-"}{ui.pageSuffix}</span>
              </div>
              <button
                className="wide-command compact"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onOpen(document);
                }}
              >
                <BookOpen size={16} />
                <span>{ui.open}</span>
              </button>
            </article>
          ))}
          {props.documents.length === 0 && (
            <div className="empty-list">
              <Upload size={30} />
              <strong>{ui.noPdfInView}</strong>
              <span>{ui.addPdfOrChooseFolder}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

type LibraryManagerViewProps = {
  state: AppStateRecord;
  documents: DocumentRecord[];
  libraryQuery: string;
  folderFilter: string;
  newFolderName: string;
  selectedDocumentIds: string[];
  onLibraryQuery: (value: string) => void;
  onFolderFilter: (value: string) => void;
  onNewFolderName: (value: string) => void;
  onCreateFolder: (parentId?: string, name?: string) => void;
  onCreateChildFolder: (parentId: string) => void;
  onRenameFolder: (folder: FolderRecord) => void;
  onDeleteFolder: (folder: FolderRecord) => void;
  onPickFile: () => void;
  onOpen: (document: DocumentRecord) => void;
  onSelect: (id: string) => void;
  onToggleSelect: (id: string, selected: boolean) => void;
  onSelectVisible: (ids: string[]) => void;
  onMoveDocuments: (ids: string[], folderId: string) => void;
  onDeleteDocuments: (ids: string[]) => void;
  onToggleBookmark: (document: DocumentRecord) => void;
};

function LibraryManagerView(props: LibraryManagerViewProps) {
  const ui = useUiStrings();
  const selectedSet = new Set(props.selectedDocumentIds);
  const visibleIds = props.documents.map((document) => document.id);
  const visibleIdSet = new Set(visibleIds);
  const selectedVisibleIds = props.selectedDocumentIds.filter((id) => visibleIdSet.has(id));
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
  const folderRows = folderTreeRows(props.state.folders, props.state.documents);
  const folderOptions = folderRows.map((row) => ({
    id: row.folder.id,
    label: `${"  ".repeat(row.depth)}${folderDisplayName(row.folder, ui)}`,
  }));
  const currentFolderLabel = props.folderFilter === "all" ? ui.allPapers : folderPathLabel(props.state.folders, props.folderFilter, ui);
  const currentParentId = props.folderFilter === "all" ? "root" : props.folderFilter;

  return (
    <section className="library-view">
      <div className="library-sidebar">
        <div className="upload-target" onClick={props.onPickFile} role="button" tabIndex={0}>
          <Upload size={26} />
          <strong>{ui.addPdf}</strong>
          <span>{ui.addPdfToSelectedFolder}</span>
        </div>
        <div className="folder-tools">
          <div className="folder-tools-head">
            <strong>{ui.folders}</strong>
            <button title={ui.createUnderCurrentFolder} className="icon-button" onClick={() => props.onCreateFolder(currentParentId)}>
              <FolderPlus size={16} />
            </button>
          </div>
          <div className="inline-input">
            <input
              value={props.newFolderName}
              onChange={(event) => props.onNewFolderName(event.target.value)}
              placeholder={ui.newFolder}
            />
            <button title={ui.createFolder} className="icon-button" onClick={() => props.onCreateFolder(currentParentId)}>
              <FolderPlus size={17} />
            </button>
          </div>
          <button
            className={props.folderFilter === "all" ? "folder-row active" : "folder-row"}
            onClick={() => props.onFolderFilter("all")}
          >
            <Archive size={16} />
            <span>{ui.allPapers}</span>
          </button>
          <div className="folder-tree">
            {folderRows.map((row) => (
              <div
                key={row.folder.id}
                className="folder-tree-row"
                data-folder-id={row.folder.id}
                style={{ "--folder-depth": row.depth } as CSSProperties}
              >
                <button
                  className={props.folderFilter === row.folder.id ? "folder-row active" : "folder-row"}
                  onClick={() => props.onFolderFilter(row.folder.id)}
                  title={folderPathLabel(props.state.folders, row.folder.id, ui)}
                >
                  {row.childCount > 0 ? <ChevronRight size={13} /> : <span className="folder-row-spacer" />}
                  <FolderOpen size={16} />
                  <span>{folderDisplayName(row.folder, ui)}</span>
              <small>User</small>
                </button>
                <div className="folder-row-actions">
                  <button data-folder-action="create-child" title={ui.createChildFolder} onClick={() => props.onCreateChildFolder(row.folder.id)}>
                    <FolderPlus size={13} />
                  </button>
                  {row.folder.id !== "root" && (
                    <button data-folder-action="rename" title={ui.rename} onClick={() => props.onRenameFolder(row.folder)}>
                      <PenLine size={13} />
                    </button>
                  )}
                  {row.folder.id !== "root" && (
                    <button data-folder-action="delete" title={ui.deleteFolder} onClick={() => props.onDeleteFolder(row.folder)}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="library-main library-manager-main">
        <div className="library-controls">
          <div className="search-box wide">
            <Search size={16} />
            <input
              value={props.libraryQuery}
              onChange={(event) => props.onLibraryQuery(event.target.value)}
              placeholder={ui.librarySearchPlaceholder}
            />
          </div>
          <span className="muted">{currentFolderLabel} · {props.documents.length} {ui.papersSuffix}</span>
        </div>
        <div className="library-bulk-bar">
          <label>
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...new Set([...props.selectedDocumentIds, ...visibleIds])]
                  : props.selectedDocumentIds.filter((id) => !visibleIdSet.has(id));
                props.onSelectVisible(next);
              }}
            />
            <span>{selectedVisibleIds.length ? `${selectedVisibleIds.length} ${ui.selectedSuffix}` : ui.currentListSelect}</span>
          </label>
          <select
            aria-label={ui.moveSelectedPapers}
            defaultValue=""
            disabled={props.selectedDocumentIds.length === 0}
            onChange={(event) => {
              const folderId = event.currentTarget.value;
              event.currentTarget.value = "";
              if (folderId) {
                props.onMoveDocuments(props.selectedDocumentIds, folderId);
              }
            }}
          >
            <option value="">{ui.moveSelectedPapersPlaceholder}</option>
            {folderOptions.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.label}
              </option>
            ))}
          </select>
          <button className="icon-button with-label danger" disabled={props.selectedDocumentIds.length === 0} onClick={() => props.onDeleteDocuments(props.selectedDocumentIds)}>
            <Trash2 size={15} />
            <span>{ui.delete}</span>
          </button>
        </div>
        <div className="document-grid">
          {props.documents.map((document) => (
            <article
              key={document.id}
              className={selectedSet.has(document.id) ? "document-card active" : "document-card"}
              title={document.title || document.fileName}
              onClick={() => props.onSelect(document.id)}
              onDoubleClick={() => props.onOpen(document)}
            >
              <div className="document-card-head">
                <label className="document-check" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedSet.has(document.id)}
                    onChange={(event) => props.onToggleSelect(document.id, event.target.checked)}
                  />
                </label>
                <FileText size={20} />
                <button
                  className="bookmark-button"
                  title={document.bookmarked ? ui.removeBookmark : ui.bookmark}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onToggleBookmark(document);
                  }}
                >
                  {document.bookmarked ? <BookmarkCheck size={18} /> : <Bookmark size={18} />}
                </button>
              </div>
              <h3>{document.title || document.fileName}</h3>
              <p>{document.authors || ui.noAuthors}</p>
              <small className="document-folder-path">{folderPathLabel(props.state.folders, document.folderId, ui)}</small>
              <div className="document-meta">
                <span>{document.year || ui.unknownYear}</span>
                <span>{document.pageCount || "-"}{ui.pageSuffix}</span>
              </div>
              <label className="document-folder-select" onClick={(event) => event.stopPropagation()}>
                <Move size={14} />
                <select value={document.folderId ?? "root"} onChange={(event) => props.onMoveDocuments([document.id], event.target.value)}>
                  {folderOptions.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="document-card-actions">
                <button
                  className="wide-command compact"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onOpen(document);
                  }}
                >
                  <BookOpen size={16} />
                  <span>{ui.open}</span>
                </button>
                <button
                  className="icon-button danger"
                  title={ui.deletePaper}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onDeleteDocuments([document.id]);
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))}
          {props.documents.length === 0 && (
            <div className="empty-list">
              <Upload size={30} />
              <strong>{ui.noPaperInView}</strong>
              <span>{ui.addPdfOrChooseFolder}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function EmptyReader(props: { label?: string; hint?: string; onPickFile: () => void }) {
  const ui = useUiStrings();
  return (
    <div className="empty-reader">
      <Upload size={36} />
      <strong>{props.label || ui.emptyReaderTitle}</strong>
      <span>{props.hint || ui.emptyReaderHint}</span>
      <button className="wide-command" onClick={props.onPickFile}>
        <Upload size={17} />
        <span>{ui.selectPdf}</span>
      </button>
    </div>
  );
}

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
  onOpenExplanation: (annotation: AnnotationRecord) => void;
  onDeleteAnnotation: (id: string) => void;
  onPreviewLink: (target: PdfLinkPreviewTarget) => void;
};

function PdfPageView(props: PdfPageViewProps) {
  const ui = useUiStrings();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
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
      props.onImageReady(props.pageNumber, canvas.toDataURL("image/png"));

      const content = await page.getTextContent();
      const extractedTextLayer = textBoxesFromPdfItems(content.items, viewport, props.zoom);
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

  return (
    <div id={`page-${props.pageNumber}`} className="pdf-page-shell" data-page={props.pageNumber}>
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
        onClick={(event) => {
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

function readableTranslationLines(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [""];
  }
  const chunks = normalized
    .split(/(?<=[.!?])\s+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line.trim()) {
      lines.push(line.trim());
      line = "";
    }
  };
  for (const chunk of chunks.length ? chunks : [normalized]) {
    const next = line ? `${line} ${chunk}` : chunk;
    if (line && next.length > 82) {
      flush();
      line = chunk;
    } else {
      line = next;
    }
    if (/[.!?]$/.test(chunk) && line.length > 48) {
      flush();
    }
  }
  flush();
  return lines.flatMap((item) => {
    if (item.length <= 110) {
      return [item];
    }
    return item.match(/.{1,100}(?:\s|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [item];
  });
}


function ReadableTranslationText(props: { text: string }) {
  return (
    <>
      {readableTranslationLines(props.text).map((line, index) => (
        <span key={`${line}-${index}`} className="translation-line">
          <InlineMathText text={line} inlineOnly />
        </span>
      ))}
    </>
  );
}

function TranslationSidecar(props: {
  ui: UiStrings;
  translationLanguageName: string;
  page: number;
  pageCount: number;
  units: TranslationUnit[];
  selectedSentenceId: string | null;
  pending: boolean;
  autoTranslate: boolean;
  onSelectSentence: (id: string) => void;
  onRefresh: () => void;
  onTranslatePage: () => void;
  onResizeStart: (event: React.PointerEvent) => void;
  onClose: () => void;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const unitKey = props.units.map((unit) => `${unit.id}:${(unit.sourceIds ?? []).join(",")}`).join("|");
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [props.selectedSentenceId, unitKey]);

  return (
    <aside className="translation-sidecar" aria-label={props.ui.translationPanel}>
      <button className="panel-resizer right" title="Resize translation panel" onPointerDown={props.onResizeStart} />
      <div className="translation-head">
        <div className="auto-state">
          <span>{props.ui.auto}</span>
          <b>{props.autoTranslate ? "ON" : "OFF"}</b>
        </div>
        <strong>
          {props.page} / {Math.max(1, props.pageCount)} · {props.translationLanguageName}
        </strong>
        <div className="translation-head-actions">
          <button title={props.ui.translatePage} onClick={props.onTranslatePage}>
            <Sparkles size={15} />
          </button>
          <button title={props.ui.refreshTranslation} onClick={props.onRefresh}>
            <RefreshCw size={15} />
          </button>
          <button title={props.ui.closeTranslationPanel} onClick={props.onClose}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="translation-body">
        {props.units.length === 0 && (
          <div className="translation-empty">{props.ui.emptyTranslation}</div>
        )}
        {props.units.map((unit) => {
          const sourceIds = unit.sourceIds?.length ? unit.sourceIds : [unit.id];
          const active = Boolean(props.selectedSentenceId && (unit.id === props.selectedSentenceId || sourceIds.includes(props.selectedSentenceId)));
          const text =
            unit.translation ||
            (unit.status === "pending"
              ? props.ui.translationPending
              : props.ui.translationMissing);
          return (
            <button
              key={unit.id}
              ref={active ? selectedRef : null}
              data-sentence-id={unit.id}
              data-source-sentence-ids={sourceIds.join(" ")}
              className={active ? "translation-sentence active" : "translation-sentence"}
              onClick={() => props.onSelectSentence(sourceIds[0] ?? unit.id)}
            >
              <span>{unit.index + 1}</span>
              <p>
                <ReadableTranslationText text={text} />
              </p>
            </button>
          );
        })}
      </div>
      {props.pending && <div className="translation-status">{props.ui.agentPending}</div>}
    </aside>
  );
}

type SelectionToolbarViewProps = {
  toolbar: SelectionToolbar;
  onExplain: () => void;
  onTranslate: () => void;
  onComment: () => void;
  onChat: () => void;
  onCopyLatex: () => void;
  onHighlight: (color: string) => void;
};

function SelectionToolbarView(props: SelectionToolbarViewProps) {
  const ui = useUiStrings();
  return (
    <div className="selection-toolbar" style={{ left: props.toolbar.x, top: props.toolbar.y }}>
      <button className="selection-row" onClick={props.onExplain}>
        <Maximize2 size={15} />
        <span>{ui.explain}</span>
        <kbd>E</kbd>
      </button>
      <button className="selection-row" onClick={() => props.onHighlight(highlightColors[0].value)}>
        <Highlighter size={15} />
        <span>{ui.highlight}</span>
        <i className="selected-color" style={{ background: "#f7c8f1" }} />
        <kbd>H</kbd>
      </button>
      <button className="selection-row" onClick={props.onTranslate}>
        <Languages size={15} />
        <span>{ui.translate}</span>
        <kbd>T</kbd>
      </button>
      <button className="selection-row" onClick={props.onComment}>
        <MessageCircle size={15} />
        <span>{ui.comment}</span>
        <kbd>C</kbd>
      </button>
      <button className="selection-row" onClick={props.onCopyLatex}>
        <Copy size={15} />
        <span>{ui.copy}</span>
      </button>
      <span className="selection-palette">
        {highlightColors.map((color) => (
          <button
            key={color.value}
            title={`${ui.highlight} ${color.name} (${color.key})`}
            className="color-dot"
            style={{ background: color.value }}
            onClick={() => props.onHighlight(color.value)}
          />
        ))}
      </span>
    </div>
  );
}

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
  onResizeStart: (event: React.PointerEvent) => void;
  onClose: () => void;
};

function RightPanel(props: RightPanelProps) {
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
          <AiPanel
            document={props.document}
            pages={props.pages}
            annotations={props.annotations}
            aiResults={props.aiResults}
            settings={props.settings}
            chatDraft={props.chatDraft}
            setChatDraft={props.setChatDraft}
            pageCursor={props.pageCursor}
            pageImages={props.pageImages}
            mode={props.assistantMode}
            onQueueTask={props.onQueueTask}
            onHoverSource={props.onHoverSource}
            onGoToPage={props.onGoToPage}
            onCopy={props.onCopy}
            onDeleteExplanation={props.onDeleteExplanation}
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

function AiPanel(props: {
  document: DocumentRecord;
  pages: PageRecord[];
  annotations: AnnotationRecord[];
  aiResults: AiResultRecord[];
  settings: Record<string, string>;
  chatDraft: string;
  setChatDraft: (value: string) => void;
  pageCursor: number;
  pageImages: Record<number, string>;
  mode: ReaderAssistantMode;
  onQueueTask: (type: AiTaskType, payload: Record<string, unknown>) => void;
  onHoverSource: (value: string | null) => void;
  onGoToPage: (page: number) => void;
  onCopy: (text: string, label: string) => void;
  onDeleteExplanation: (result: AiResultRecord) => void;
}) {
  const ui = useUiStrings();
  return (
    <div className={props.mode === "quotes" ? "assistant-surface quote-mode" : "assistant-surface"}>
      {props.mode === "study" && (
        <div className="chat-panel">
          <ChatThread
            results={props.aiResults}
            onHoverSource={props.onHoverSource}
            onGoToPage={props.onGoToPage}
            onCopy={props.onCopy}
          />
          <ChatComposer
            value={props.chatDraft}
            onChange={props.setChatDraft}
            modelLabel={aiRuntimeLabel(props.settings, ui)}
            onSend={() => {
              const question = props.chatDraft.trim();
              if (!question) {
                return;
              }
              props.onQueueTask("chatWithPaper", { question });
              props.setChatDraft("");
            }}
          />
        </div>
      )}
      {props.mode === "quotes" && (
        <QuoteCardPanel
          results={props.aiResults}
          annotations={props.annotations}
          onQueueTask={props.onQueueTask}
          onCopy={props.onCopy}
          onHoverSource={props.onHoverSource}
          onDeleteExplanation={props.onDeleteExplanation}
        />
      )}
    </div>
  );
}

function ChatThread(props: {
  results: AiResultRecord[];
  onHoverSource: (value: string | null) => void;
  onGoToPage: (page: number) => void;
  onCopy: (text: string, label: string) => void;
}) {
  const ui = useUiStrings();
  const chatResults = props.results
    .filter((result) => {
      const taskType = result.taskType.toString();
      return taskType === "chatWithPaper" || (taskType === chatPlanTaskType && result.status === "pending");
    })
    .slice()
    .sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
    });
  return (
    <section className="chat-thread" aria-label={ui.askAi}>
      {chatResults.length === 0 && (
        <div className="chat-thread-empty">
          <MessageSquareText size={20} />
          <strong>{ui.askAi}</strong>
          <span>{ui.askAnything}</span>
        </div>
      )}
      {chatResults.map((result) => {
        const isPending = result.status === "pending";
        const answer = isPending ? ui.aiPendingAnswer : getReadableAiOutput(result, ui);
        return (
          <article key={result.id} className="chat-turn">
            <div className="chat-bubble user">
              <small>User</small>
              <p>{result.inputText}</p>
            </div>
            <div
              className={`chat-bubble assistant ${result.status}`}
              onMouseEnter={() => props.onHoverSource(result.inputText)}
              onMouseLeave={() => props.onHoverSource(null)}
            >
              <div className="chat-bubble-head">
              <small>User</small>
                <span>{formatResultTime(result.createdAt)}</span>
                {!isPending && (
                  <button title={ui.copy} onClick={() => props.onCopy(answer, ui.askAi)}>
                    <Copy size={13} />
                  </button>
                )}
              </div>
              <FormattedAiText text={answer} onPageCitation={props.onGoToPage} />
            </div>
          </article>
        );
      })}
    </section>
  );
}

function TranslationReader(props: { page: number; pageCount: number; text: string; source: string; onRefresh: () => void }) {
  const ui = useUiStrings();
  return (
    <section className="translation-reader">
      <div className="translation-head">
        <span className="auto-chip">{ui.auto} <b>OFF</b></span>
        <strong>{props.page} / {props.pageCount}</strong>
        <div>
          <button title={ui.refresh} onClick={props.onRefresh}><RefreshCw size={16} /></button>
        </div>
      </div>
      <div className="translation-copy">
        <p>{props.text}</p>
      </div>
      <span className="translation-source">{props.source}</span>
    </section>
  );
}

function AiInsightSection(props: {
  section: AiDisplaySection;
  results: AiResultRecord[];
  keywords: string[];
  pages: PageRecord[];
  onQueueTask: (type: AiTaskType, payload: Record<string, unknown>) => void;
  onCopy: (text: string, label: string) => void;
}) {
  const ui = useUiStrings();
  const result = latestInsightResult(props.results, props.section);
  const title = ui[props.section.titleKey] ?? props.section.id;
  const text = result ? limitInsightText(props.section.id, getReadableAiOutput(result, ui)) : "";
  const copyText = text || props.keywords.join(", ");
  return (
    <section className="ai-insight-section">
      <div className="section-title-row">
        <h3>{title}</h3>
        <ChevronDown size={15} />
      </div>
      <div className="section-tools">
        <button title={ui.copy} onClick={() => props.onCopy(copyText, title)}><Copy size={14} /></button>
        <button title={ui.refresh} onClick={() => props.onQueueTask(props.section.id === "keywords" ? "outlineDocument" : "summarizePaper", { mode: props.section.id === "three" ? "three-line" : "detailed", pages: props.pages })}><RefreshCw size={14} /></button>
      </div>
      {props.keywords.length > 0 && (
        <div className="keyword-cloud">
          {props.keywords.map((keyword) => (
            <span key={keyword}>{keyword}</span>
          ))}
        </div>
      )}
      {text ? <FormattedAiText text={text} compact={props.section.id === "three"} /> : props.keywords.length === 0 ? <p className="muted">{ui[props.section.emptyKey]}</p> : null}
    </section>
  );
}

function QuoteCardPanel(props: {
  results: AiResultRecord[];
  annotations: AnnotationRecord[];
  onQueueTask: (type: AiTaskType, payload: Record<string, unknown>) => void;
  onCopy: (text: string, label: string) => void;
  onHoverSource: (value: string | null) => void;
  onDeleteExplanation: (result: AiResultRecord) => void;
}) {
  const ui = useUiStrings();
  const quoteResults = props.results.filter((result) =>
    ["explainText", "explainRegionImage", "citationReason", "externalLinkSummary"].includes(result.taskType.toString()),
  );
  return (
    <section className="quote-card-panel">
      <h3>{ui.explain}</h3>
      <div className="annotation-filters">
        <label><input type="checkbox" defaultChecked /> {ui.all}</label>
        {annotationFilters.map((filter) => (
          <label key={filter.id}>
            <input type="checkbox" defaultChecked />
            <span style={{ background: filter.color }}>{ui[filter.labelKey]}</span>
          </label>
        ))}
      </div>
      <div className="quote-search">
        <Search size={15} />
        <input placeholder={ui.quoteSearch} />
      </div>
      {quoteResults.map((result) => {
        const linkedAnnotation = props.annotations.find((annotation) => explanationResultId(annotation) === result.id);
        const isExplanation = explanationTasks.has(result.taskType.toString());
        const pageLabel = linkedAnnotation ? `Page ${linkedAnnotation.page}` : "";
        return (
        <article
          key={result.id}
          className="quote-card"
          onMouseEnter={() => props.onHoverSource(result.inputText)}
          onMouseLeave={() => props.onHoverSource(null)}
        >
          <div className="quote-avatar">Tt</div>
          <div>
            <time>{[formatResultTime(result.createdAt), "Chat 0", pageLabel].filter(Boolean).join(" / ")}</time>
            <h4>{taskTitle(result.taskType.toString(), ui)}</h4>
            <FormattedAiText text={getReadableAiOutput(result, ui)} compact={!isExplanation} />
          </div>
          <div className="quote-card-actions">
          <button title={ui.copy} onClick={() => props.onCopy(getReadableAiOutput(result, ui), taskTitle(result.taskType.toString(), ui))}>
            <Copy size={16} />
          </button>
            {isExplanation && (
              <button title={ui.deleteExplanation} onClick={() => props.onDeleteExplanation(result)}>
                <Trash2 size={16} />
              </button>
            )}
          </div>
        </article>
        );
      })}
      {quoteResults.length === 0 && <p className="muted">{ui.quoteCardsEmpty}</p>}
    </section>
  );
}

function ChatComposer(props: { value: string; modelLabel: string; onChange: (value: string) => void; onSend: () => void }) {
  const ui = useUiStrings();
  return (
    <div className="assistant-composer">
      <textarea value={props.value} onChange={(event) => props.onChange(event.target.value)} placeholder={ui.askAnything} />
      <div className="composer-footer">
        <span className="composer-model-chip">{props.modelLabel}</span>
        <button className="send-round" title={ui.send} onClick={props.onSend}><Send size={15} /></button>
      </div>
    </div>
  );
}

function renderKatex(value: string, displayMode = false): string {
  try {
    return katex.renderToString(value.trim(), {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
    });
  } catch {
    return escapeHtml(value);
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function MathChunk(props: { value: string; display?: boolean }) {
  const html = renderKatex(normalizeDisplayMathValue(props.value), props.display);
  if (props.display) {
    return <div className="math-block" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <span className="math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

function normalizeMathDelimiters(value: string) {
  return value
    .replace(/\\\\([()[\]])/g, "\\$1")
    .replace(/\\\\([A-Za-z]+)/g, "\\$1")
    .replace(/\\\\(begin|end)\{/g, "\\$1{");
}

function normalizeDisplayMathValue(value: string) {
  const text = normalizeMathDelimiters(value).trim();
  const env = text.match(/^\\begin\{([A-Za-z]+)\*?\}([\s\S]*)\\end\{\1\*?\}$/);
  if (!env) {
    return text;
  }
  const name = env[1];
  const body = env[2].trim();
  if (name === "equation") {
    return body;
  }
  if (name === "align" || name === "aligned" || name === "multline") {
    return `\\begin{aligned}${body}\\end{aligned}`;
  }
  if (name === "gather" || name === "gathered") {
    return `\\begin{gathered}${body}\\end{gathered}`;
  }
  return text;
}

function autoDelimitOutlineMathSegment(segment: string) {
  type Candidate = { start: number; end: number; value: string; priority: number };
  const candidates: Candidate[] = [];
  const addMatches = (pattern: RegExp, transform: (match: RegExpExecArray) => string, priority: number) => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(segment); match; match = pattern.exec(segment)) {
      const raw = match[0];
      const start = match.index ?? 0;
      const end = start + raw.length;
      if (!raw.trim() || segment[start - 1] === "$" || segment[end] === "$") {
        continue;
      }
      candidates.push({ start, end, value: transform(match).trim(), priority });
    }
  };

  addMatches(/\bR2\b(?=\s*(?:score|coefficient|regression|value|metric)\b)/gi, () => "R^2", 8);
  addMatches(
    /\b([A-Za-z])([0-9])(?=(?:[-\s]?(?:regulari[sz]ed|norm|loss|penalty|objective|distance|metric|constraint|error|score|model|method))\b)/gi,
    (match) => `${match[1]}_${match[2]}`,
    7,
  );
  addMatches(/\\[A-Za-z]+(?:\s*[_^]\s*(?:\{[^}]+\}|[A-Za-z0-9]+))*/g, (match) => match[0], 6);
  addMatches(/\bO\([^)]{1,36}\)/g, (match) => match[0], 6);
  addMatches(
    /\b[A-Za-z][A-Za-z0-9]*(?:[_^](?:\{[^}]+\}|[A-Za-z0-9]+))+(?:\s*(?:[+\-*/=]|<=|>=|=>)\s*[A-Za-z0-9\\_{}^]+)*/g,
    (match) => match[0],
    5,
  );
  addMatches(/[\u0391-\u03A9\u03B1-\u03C9](?:\s*[_^]\s*(?:\{[^}]+\}|[A-Za-z0-9]+))?/g, (match) => match[0], 4);
  addMatches(
    /\b[A-Za-z][A-Za-z0-9_{}^]*\s*(?:=|<=|>=|<|>)\s*[A-Za-z0-9\\_{}^+\-*/().\s]{1,36}/g,
    (match) => match[0].trim(),
    3,
  );

  if (candidates.length === 0) {
    return segment;
  }
  const selected: Candidate[] = [];
  for (const candidate of candidates.sort(
    (a, b) => a.start - b.start || b.priority - a.priority || b.end - b.start - (a.end - a.start),
  )) {
    if (!selected.some((item) => Math.max(item.start, candidate.start) < Math.min(item.end, candidate.end))) {
      selected.push(candidate);
    }
  }
  selected.sort((a, b) => a.start - b.start);
  let cursor = 0;
  let output = "";
  for (const candidate of selected) {
    output += segment.slice(cursor, candidate.start);
    output += `$${candidate.value}$`;
    cursor = candidate.end;
  }
  return output + segment.slice(cursor);
}

function outlineTextWithMathDelimiters(value: string) {
  const text = normalizeMathDelimiters(value);
  const pattern = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g;
  let cursor = 0;
  let output = "";
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      output += autoDelimitOutlineMathSegment(text.slice(cursor, index));
    }
    output += match[0];
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    output += autoDelimitOutlineMathSegment(text.slice(cursor));
  }
  return output;
}

function OutlineTitleText(props: { text: string }) {
  return (
    <span className="outline-title-text">
      <InlineMathText text={outlineTextWithMathDelimiters(props.text)} inlineOnly />
    </span>
  );
}

function InlinePageCitationText(props: { text: string; onPageCitation?: (page: number) => void }) {
  const ui = useUiStrings();
  if (!props.onPageCitation) {
    return <>{props.text}</>;
  }
  const chunks: ReactNode[] = [];
  const pattern = /(\((?:p|page)\.?\s*(\d+)\)|\b(?:p|page)\.?\s*(\d+)\b)/gi;
  let cursor = 0;
  for (const match of props.text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const page = Number(match[2] ?? match[3]);
    if (index > cursor) {
      chunks.push(props.text.slice(cursor, index));
    }
    chunks.push(
      <button
        key={`${match[0]}-${index}`}
        type="button"
        className="page-citation-link"
        title={ui.goToPage}
        onClick={() => props.onPageCitation?.(page)}
      >
        {`(p. ${page})`}
      </button>,
    );
    cursor = index + match[0].length;
  }
  if (cursor < props.text.length) {
    chunks.push(props.text.slice(cursor));
  }
  return <>{chunks}</>;
}

function InlineMarkdownText(props: { text: string; onPageCitation?: (page: number) => void }) {
  const chunks: Array<{ value: string; strong: boolean }> = [];
  const pattern = /\*\*([^*]+(?:\*(?!\*)[^*]+)*)\*\*/g;
  let cursor = 0;
  for (const match of props.text.matchAll(pattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      chunks.push({ value: props.text.slice(cursor, index), strong: false });
    }
    chunks.push({ value: match[1], strong: true });
    cursor = index + raw.length;
  }
  if (cursor < props.text.length) {
    chunks.push({ value: props.text.slice(cursor), strong: false });
  }
  if (chunks.length === 0) {
    return <>{props.text}</>;
  }
  return (
    <>
      {chunks.map((chunk, index) =>
        chunk.strong ? (
          <strong key={`${chunk.value}-${index}`}>
            <InlinePageCitationText text={chunk.value} onPageCitation={props.onPageCitation} />
          </strong>
        ) : (
          <span key={`${chunk.value}-${index}`}>
            <InlinePageCitationText text={chunk.value} onPageCitation={props.onPageCitation} />
          </span>
        ),
      )}
    </>
  );
}

function InlineMathText(props: { text: string; inlineOnly?: boolean; onPageCitation?: (page: number) => void }) {
  const chunks: Array<{ value: string; math: boolean; display?: boolean }> = [];
  const text = normalizeMathDelimiters(props.text);
  const pattern = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      chunks.push({ value: text.slice(cursor, index), math: false });
    }
    if (raw.startsWith("$$") && raw.endsWith("$$")) {
      chunks.push({ value: raw.slice(2, -2), math: true, display: !props.inlineOnly });
    } else if (raw.startsWith("\\[") && raw.endsWith("\\]")) {
      chunks.push({ value: raw.slice(2, -2), math: true, display: !props.inlineOnly });
    } else if (raw.startsWith("\\(") && raw.endsWith("\\)")) {
      chunks.push({ value: raw.slice(2, -2), math: true });
    } else {
      chunks.push({ value: raw.slice(1, -1), math: true });
    }
    cursor = index + raw.length;
  }
  if (cursor < text.length) {
    chunks.push({ value: text.slice(cursor), math: false });
  }
  if (!chunks.some((chunk) => chunk.math)) {
    return <InlineMarkdownText text={text} onPageCitation={props.onPageCitation} />;
  }
  return (
    <>
      {chunks.map((chunk, index) =>
        chunk.math ? (
          <MathChunk key={`${chunk.value}-${index}`} value={chunk.value} display={chunk.display} />
        ) : (
          <span key={`${chunk.value}-${index}`}>
            <InlineMarkdownText text={chunk.value} onPageCitation={props.onPageCitation} />
          </span>
        ),
      )}
    </>
  );
}

type FormattedAiBlock =
  | { kind: "math"; value: string }
  | { kind: "text"; value: string };

function readDelimitedMathBlock(lines: string[], startIndex: number, startToken: string, endToken: string) {
  const firstLine = normalizeMathDelimiters(lines[startIndex].trim());
  const firstBody = firstLine.slice(startToken.length);
  const sameLineEnd = firstBody.indexOf(endToken);
  if (sameLineEnd >= 0) {
    return { value: firstBody.slice(0, sameLineEnd), nextIndex: startIndex + 1 };
  }
  const parts = [firstBody];
  let index = startIndex + 1;
  while (index < lines.length) {
    const line = normalizeMathDelimiters(lines[index]);
    const endIndex = line.indexOf(endToken);
    if (endIndex >= 0) {
      parts.push(line.slice(0, endIndex));
      return { value: parts.join("\n"), nextIndex: index + 1 };
    }
    parts.push(line);
    index += 1;
  }
  return { value: firstLine, nextIndex: startIndex + 1, unclosed: true };
}

function readEnvironmentMathBlock(lines: string[], startIndex: number) {
  const firstLine = normalizeMathDelimiters(lines[startIndex].trim());
  const start = firstLine.match(/^\\begin\{([A-Za-z]+)\*?\}/);
  if (!start) {
    return null;
  }
  const envName = start[1];
  const endPattern = new RegExp(`\\\\end\\{${envName}\\*?\\}`);
  const parts = [firstLine];
  if (endPattern.test(firstLine)) {
    return { value: firstLine, nextIndex: startIndex + 1 };
  }
  let index = startIndex + 1;
  while (index < lines.length) {
    const line = normalizeMathDelimiters(lines[index]);
    parts.push(line);
    if (endPattern.test(line)) {
      return { value: parts.join("\n"), nextIndex: index + 1 };
    }
    index += 1;
  }
  return { value: firstLine, nextIndex: startIndex + 1, unclosed: true };
}

function formattedAiBlocks(value: string): FormattedAiBlock[] {
  const lines = value.replace(/\r/g, "").split("\n");
  const blocks: FormattedAiBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = normalizeMathDelimiters(lines[index].trim());
    if (!line) {
      index += 1;
      continue;
    }
    if (line.startsWith("$$")) {
      const block = readDelimitedMathBlock(lines, index, "$$", "$$");
      blocks.push(block.unclosed ? { kind: "text", value: block.value } : { kind: "math", value: block.value });
      index = block.nextIndex;
      continue;
    }
    if (line.startsWith("\\[")) {
      const block = readDelimitedMathBlock(lines, index, "\\[", "\\]");
      blocks.push(block.unclosed ? { kind: "text", value: block.value } : { kind: "math", value: block.value });
      index = block.nextIndex;
      continue;
    }
    if (/^\\begin\{(?:equation|align|gather|multline|split|aligned|gathered)\*?\}/.test(line)) {
      const block = readEnvironmentMathBlock(lines, index);
      if (block) {
        blocks.push(block.unclosed ? { kind: "text", value: block.value } : { kind: "math", value: block.value });
        index = block.nextIndex;
        continue;
      }
    }
    blocks.push({ kind: "text", value: line });
    index += 1;
  }
  return blocks;
}

function FormattedAiLine(props: { line: string; index: number; onPageCitation?: (page: number) => void }) {
  const normalizedLine = normalizeMathDelimiters(props.line);
  const displayMath =
    normalizedLine.match(/^\$\$([\s\S]+)\$\$$/) ??
    normalizedLine.match(/^\\\[([\s\S]+)\\\]$/) ??
    normalizedLine.match(/^\\begin\{(?:equation|align|gather|multline|split|aligned|gathered)\*?\}([\s\S]+)\\end\{(?:equation|align|gather|multline|split|aligned|gathered)\*?\}$/);
  if (displayMath) {
    return <MathChunk key={`${props.line}-${props.index}`} value={displayMath[1]} display />;
  }
  const heading = normalizedLine.match(/^#{1,4}\s+(.+)/) ?? normalizedLine.match(/^\*\*(.+)\*\*:?$/);
  if (heading) {
    return (
      <h4 key={`${props.line}-${props.index}`}>
        <InlineMathText text={heading[1]} onPageCitation={props.onPageCitation} />
      </h4>
    );
  }
  const numbered = normalizedLine.match(/^(\d+)[.)]\s+(.+)/);
  if (numbered) {
    return (
      <div key={`${props.line}-${props.index}`} className="numbered-line">
        <b>{numbered[1]}.</b>
        <span>
          <InlineMathText text={numbered[2]} onPageCitation={props.onPageCitation} />
        </span>
      </div>
    );
  }
  const bullet = normalizedLine.match(/^[-*]\s+(.+)/);
  if (bullet) {
    return (
      <div key={`${props.line}-${props.index}`} className="bullet-line">
        <i />
        <span>
          <InlineMathText text={bullet[1]} onPageCitation={props.onPageCitation} />
        </span>
      </div>
    );
  }
  return (
    <p key={`${props.line}-${props.index}`}>
      <InlineMathText text={normalizedLine} onPageCitation={props.onPageCitation} />
    </p>
  );
}

function FormattedAiText(props: { text: string; compact?: boolean; onPageCitation?: (page: number) => void }) {
  const blocks = formattedAiBlocks(props.text);
  const lines: string[] = [];
  if (blocks.length === 0) {
    return null;
  }
  return (
    <div className={props.compact ? "formatted-ai compact" : "formatted-ai"}>
      {blocks.map((block, index) =>
        block.kind === "math" ? (
          <MathChunk key={`math-${index}-${block.value}`} value={block.value} display />
        ) : (
          <FormattedAiLine key={`text-${index}-${block.value}`} line={block.value} index={index} onPageCitation={props.onPageCitation} />
        ),
      )}
      {lines.map((line, index) => {
        const normalizedLine = normalizeMathDelimiters(line);
        const displayMath =
          normalizedLine.match(/^\$\$([\s\S]+)\$\$$/) ??
          normalizedLine.match(/^\\\[([\s\S]+)\\\]$/) ??
          normalizedLine.match(/^\\begin\{(?:equation|align|gather)\*?\}([\s\S]+)\\end\{(?:equation|align|gather)\*?\}$/);
        if (displayMath) {
          return <MathChunk key={`${line}-${index}`} value={displayMath[1]} display />;
        }
        const heading = normalizedLine.match(/^#{1,4}\s+(.+)/) ?? normalizedLine.match(/^\*\*(.+)\*\*:?$/);
        if (heading) {
          return (
            <h4 key={`${line}-${index}`}>
              <InlineMathText text={heading[1]} />
            </h4>
          );
        }
        const numbered = normalizedLine.match(/^(\d+)[.)]\s+(.+)/);
        if (numbered) {
          return (
            <div key={`${line}-${index}`} className="numbered-line">
              <b>{numbered[1]}.</b>
              <span>
                <InlineMathText text={numbered[2]} />
              </span>
            </div>
          );
        }
        const bullet = normalizedLine.match(/^[-*]\s+(.+)/);
        if (bullet) {
          return (
            <div key={`${line}-${index}`} className="bullet-line">
              <i />
              <span>
                <InlineMathText text={bullet[1]} />
              </span>
            </div>
          );
        }
        return (
          <p key={`${line}-${index}`}>
            <InlineMathText text={normalizedLine} />
          </p>
        );
      })}
    </div>
  );
}

function ResultList(props: {
  results: AiResultRecord[];
  onHoverSource: (value: string | null) => void;
  onCopy: (text: string, label: string) => void;
  onDeleteExplanation: (result: AiResultRecord) => void;
}) {
  const ui = useUiStrings();
  const visibleResults = props.results.filter((result) => !rightPanelHiddenTasks.has(result.taskType.toString()));
  if (visibleResults.length === 0) {
    return <p className="muted">{ui.aiResultsEmpty}</p>;
  }
  return (
    <div className="result-list compact-results">
      {visibleResults.map((result) => {
        const fullText = getReadableAiOutput(result, ui);
        const isExplanation = explanationTasks.has(result.taskType.toString());
        const previewText = isExplanation ? fullText : resultPreviewText(result, ui);
        return (
          <article
            key={result.id}
            className="result-card"
            onMouseEnter={() => props.onHoverSource(result.inputText)}
            onMouseLeave={() => props.onHoverSource(null)}
          >
            <div className="result-head">
              <strong>{taskTitle(result.taskType.toString(), ui)}</strong>
              <span className={`status ${result.status}`}>{result.status}</span>
            </div>
            <FormattedAiText text={previewText} compact={!isExplanation} />
            <div className="result-actions">
              <button onClick={() => props.onCopy(fullText, taskTitle(result.taskType.toString(), ui))}>
                <Copy size={14} />
                {ui.copy}
              </button>
              {isExplanation && (
                <button title={ui.deleteExplanation} onClick={() => props.onDeleteExplanation(result)}>
                  <Trash2 size={14} />
                  {ui.delete}
                </button>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function FloatingAiCard(props: { result: AiResultRecord; onClose: () => void; onCopy: () => void; onDelete: (result: AiResultRecord) => void }) {
  const ui = useUiStrings();
  const [expanded, setExpanded] = useState(false);
  const isExplanation = explanationTasks.has(props.result.taskType.toString());
  return (
    <aside className={expanded ? "floating-ai-card expanded" : "floating-ai-card"}>
      <div className="floating-card-head">
        <div>
          <Maximize2 size={16} />
          <strong>{taskTitle(props.result.taskType.toString(), ui)}</strong>
        </div>
        <div>
          <button title={expanded ? ui.compactView : ui.fullScreen} onClick={() => setExpanded((value) => !value)}>
            <Maximize2 size={15} />
          </button>
          <button title={ui.copy} onClick={props.onCopy}>
            <Copy size={15} />
          </button>
          {isExplanation && (
            <button title={ui.deleteExplanation} onClick={() => props.onDelete(props.result)}>
              <Trash2 size={15} />
            </button>
          )}
          <button title={ui.close} onClick={props.onClose}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="floating-card-body">
        <FormattedAiText text={getReadableAiOutput(props.result, ui)} />
      </div>
    </aside>
  );
}

function LinkPreviewModal(props: {
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

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
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
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    setOffset({
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    });
  };
  const stopPan = (event: React.PointerEvent<HTMLDivElement>) => {
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

function ActivityPanel(props: {
  annotations: AnnotationRecord[];
  onUpdateAnnotation: (annotation: AnnotationRecord) => void;
  onDeleteAnnotation: (id: string) => void;
  onDeleteAllAnnotations: () => void;
  onGoToPage: (page: number) => void;
}) {
  const ui = useUiStrings();
  const grouped = props.annotations.reduce<Record<string, AnnotationRecord[]>>((accumulator, annotation) => {
    const key = annotation.tag || annotation.kind;
    accumulator[key] = accumulator[key] ?? [];
    accumulator[key].push(annotation);
    return accumulator;
  }, {});
  return (
    <div className="panel-stack">
      <button className="wide-command danger" onClick={props.onDeleteAllAnnotations} disabled={props.annotations.length === 0}>
        <Trash2 size={16} />
        <span>{ui.deleteAllHighlights}</span>
      </button>
      {Object.entries(grouped).map(([group, annotations]) => (
        <section key={group} className="panel-section">
          <h3>{group}</h3>
          {annotations.map((annotation) => (
            <article key={annotation.id} className="annotation-row">
              <button className="swatch" style={{ background: annotation.color }} title={ui.goToHighlight} onClick={() => props.onGoToPage(annotation.page)} />
              <div>
                <strong>{ui.page} {annotation.page}</strong>
                <p>{annotation.text}</p>
              <small>User</small>
                <div className="annotation-colors">
                  {highlightColors.map((color) => (
                    <button
                      key={color.value}
                      className="color-dot"
                      style={{ background: color.value }}
                      title={`${ui.changeTo} ${color.name}`}
                      onClick={() => props.onUpdateAnnotation({ ...annotation, color: color.value })}
                    />
                  ))}
                </div>
              </div>
              <button title={ui.delete} className="icon-button" onClick={() => props.onDeleteAnnotation(annotation.id)}>
                <Trash2 size={15} />
              </button>
            </article>
          ))}
        </section>
      ))}
      {props.annotations.length === 0 && <p className="muted">{ui.manualAiHighlightsEmpty}</p>}
    </div>
  );
}

function CitationsPanel(props: {
  document: DocumentRecord;
  citations: CitationCardRecord[];
  onExtractCitations: () => void;
  onResolveCitationLinks: () => void;
  onDeleteCitation: (id: string) => void;
  onSaveCitation: (card: CitationCardRecord) => void;
  onQueueTask: (type: AiTaskType, payload: Record<string, unknown>) => void;
  onCopy: (text: string, label: string) => void;
  onHoverSource: (value: string | null) => void;
}) {
  const ui = useUiStrings();
  return (
    <div className="panel-stack">
      <div className="command-grid">
        <button onClick={props.onExtractCitations}>
          <Search size={16} />
          <span>{ui.extractReferences}</span>
        </button>
        <button onClick={props.onResolveCitationLinks}>
          <Link size={16} />
          <span>{ui.findLinks}</span>
        </button>
        <button onClick={() => void props.onCopy(citationCardsToBibtex(props.citations), "BibTeX")}>
          <Copy size={16} />
          <span>BibTeX</span>
        </button>
        <button onClick={() => void props.onCopy(citationCardsToCsv(props.citations), "CSV")}>
          <Download size={16} />
          <span>CSV</span>
        </button>
      </div>
      {props.citations.map((card) => (
        <article
          key={card.id}
          className="citation-card"
          onMouseEnter={() => props.onHoverSource(card.rawReference)}
          onMouseLeave={() => props.onHoverSource(null)}
        >
          <div className="citation-head">
            <strong>{card.title || ui.untitledReference}</strong>
            <button title={ui.deleteCitation} className="icon-button" onClick={() => props.onDeleteCitation(card.id)}>
              <Trash2 size={15} />
            </button>
          </div>
          <p>{card.authors}</p>
              <small>User</small>
          <div className="micro-actions">
            <button disabled={!card.url && !card.doi} onClick={() => openPaperUrl(card)}>{ui.openPaper}</button>
            {card.doi && <button onClick={() => openPaperUrl({ ...card, url: "" })}>DOI</button>}
          </div>
          <textarea
            value={card.reason}
            onChange={(event) => props.onSaveCitation({ ...card, reason: event.target.value })}
            placeholder={ui.citationReasonPlaceholder}
          />
          <div className="micro-actions">
            <button onClick={() => props.onQueueTask("citationReason", { reference: card.rawReference })}>{ui.reason}</button>
            <button onClick={() => props.onQueueTask("externalLinkSummary", { url: card.url, reference: card.rawReference })}>{ui.linkSummary}</button>
          </div>
        </article>
      ))}
      {props.citations.length === 0 && <p className="muted">{ui.extractReferencesEmpty}</p>}
    </div>
  );
}

function NotesPanel(props: { note: NoteRecord | null; fullText: string; onSaveNote: (markdown: string) => Promise<void>; onDeleteNote: () => Promise<void> }) {
  const ui = useUiStrings();
  const [draft, setDraft] = useState(props.note?.markdown ?? "");
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  useEffect(() => {
    setDraft(props.note?.markdown ?? "");
    setSaveState("idle");
  }, [props.note?.id]);
  async function submitNote() {
    setSaveState("saving");
    try {
      await props.onSaveNote(draft);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }
  return (
    <div className="panel-stack notes-panel">
      <textarea
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setSaveState("dirty");
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            void submitNote();
          }
        }}
        placeholder={ui.markdownNotes}
      />
      <div className="note-actions">
        <button className="wide-command" disabled={saveState === "saving"} onClick={() => void submitNote()}>
          <Save size={16} />
          <span>{saveState === "saving" ? ui.saving : ui.saveNote}</span>
        </button>
        <button
          className="wide-command danger"
          disabled={saveState === "saving" || (!props.note?.markdown && !draft)}
          onClick={() => {
            void props.onDeleteNote().then(() => {
              setDraft("");
              setSaveState("idle");
            });
          }}
        >
          <Trash2 size={16} />
          <span>{ui.deleteNote}</span>
        </button>
      </div>
      <small className={saveState === "error" ? "note-save-status error" : "note-save-status"}>
        {saveState === "dirty" && ui.unsavedChanges}
        {saveState === "saved" && ui.saved}
        {saveState === "error" && ui.saveFailed}
      </small>
    </div>
  );
}

function InfoPanel(props: {
  document: DocumentRecord;
  folders: FolderRecord[];
  outlineRows: OutlineRow[];
  searchMatches: number[];
  onMetadata: (field: keyof DocumentRecord, value: string | boolean | null) => void;
  onMoveFolder: (folderId: string) => void;
  onGoToPage: (page: number) => void;
  onJsonExport: () => void;
  onZipExport: () => void;
}) {
  const ui = useUiStrings();
  const folderOptions = folderTreeRows(props.folders, []).map((row) => ({
    id: row.folder.id,
    label: `${"  ".repeat(row.depth)}${folderDisplayName(row.folder, ui)}`,
  }));
  return (
    <div className="panel-stack">
      <label className="field">
        <span>{ui.title}</span>
        <input value={props.document.title} onChange={(event) => props.onMetadata("title", event.target.value)} />
      </label>
      <label className="field">
        <span>{ui.authors}</span>
        <input value={props.document.authors} onChange={(event) => props.onMetadata("authors", event.target.value)} />
      </label>
      <label className="field">
        <span>{ui.year}</span>
        <input value={props.document.year} onChange={(event) => props.onMetadata("year", event.target.value)} />
      </label>
      <label className="field">
        <span>{ui.abstract}</span>
        <textarea value={props.document.abstractText} onChange={(event) => props.onMetadata("abstractText", event.target.value)} />
      </label>
      <label className="field">
        <span>{ui.folder}</span>
        <select value={props.document.folderId ?? "root"} onChange={(event) => props.onMoveFolder(event.target.value)}>
          {folderOptions.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.label}
            </option>
          ))}
        </select>
      </label>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={props.document.bookmarked}
          onChange={(event) => props.onMetadata("bookmarked", event.target.checked)}
        />
        <span>{ui.bookmark}</span>
      </label>
      <div className="command-grid">
        <button onClick={props.onJsonExport}>
          <Download size={16} />
          <span>{ui.jsonExport}</span>
        </button>
        <button onClick={props.onZipExport}>
          <FileArchive size={16} />
          <span>{ui.zipExport}</span>
        </button>
      </div>
      <section className="panel-section">
        <h3>{ui.outline}</h3>
        {(props.outlineRows.length ? props.outlineRows : [{ id: "page-1", page: 1, title: `${ui.page} 1`, level: 0, source: "page" as const }]).map((row, index) => (
          <button key={`${row.id}-${index}`} className="outline-row" onClick={() => props.onGoToPage(row.page)}>
            <ListTree size={14} />
            <span>
              <OutlineTitleText text={row.title} />
            </span>
          </button>
        ))}
      </section>
      <section className="panel-section">
        <h3>{ui.searchHits}</h3>
        {props.searchMatches.map((page) => (
          <button key={page} className="outline-row" onClick={() => props.onGoToPage(page)}>
            <Search size={14} />
            <span>{ui.page} {page}</span>
          </button>
        ))}
        {props.searchMatches.length === 0 && <p className="muted">{ui.noActiveSearchHits}</p>}
      </section>
    </div>
  );
}

function SettingsView(props: {
  ui: UiStrings;
  uiLanguage: UiLanguage;
  settings: Record<string, string>;
  agentStatuses: Partial<Record<AiProviderKind, AgentProviderStatus>>;
  runtime: string;
  onChange: (key: string, value: string) => void;
  onResetWorkspace: () => void;
}) {
  const provider = normalizeAiProviderKind(props.settings.aiProvider);
  const providerStatus = props.agentStatuses[provider];
  const claudeMissing = props.agentStatuses["claude-code"]?.installed === false;
  const providerStatusLabel =
    providerStatus?.installed === true ? props.ui.installed : providerStatus?.installed === false ? props.ui.notInstalled : props.ui.unknown;
  const providerStatusMessage = providerStatus?.installed === null ? props.ui.browserPreviewStatus : providerStatus?.message;
  const selectedModel = aiModelForProvider(props.settings, provider);
  const modelOptions = providerModelOptions[provider];
  const selectedModelIsKnown = modelOptions.some((option) => option.value === selectedModel);
  const setSelectedModel = (value: string) => {
    props.onChange(providerModelSettingKey(provider), value);
    props.onChange("aiModel", value);
  };
  return (
    <section className="settings-view">
      <div className="settings-header">
        <div>
          <h2>{props.ui.settingsTitle}</h2>
          <p>{props.ui.settingsSubtitle}</p>
        </div>
      </div>
      <div className="settings-grid">
        <label className="field">
          <span>{props.ui.uiLanguage}</span>
          <select
            value={uiLanguageFromSettings(props.settings)}
            onChange={(event) => {
              props.onChange("uiLanguage", event.target.value);
              props.onChange("language", event.target.value);
            }}
          >
            <option value="ko">Korean</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="field">
          <span>{props.ui.translationLanguage}</span>
          <select
            value={translationLanguageOption(props.settings.translationLanguage).value}
            onChange={(event) => props.onChange("translationLanguage", event.target.value)}
          >
            {translationLanguageOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {props.uiLanguage === "ko" ? option.ko : option.en}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{props.ui.theme}</span>
          <select value={props.settings.theme} onChange={(event) => props.onChange("theme", event.target.value)}>
            <option value="light">Light</option>
            <option value="ink">Ink</option>
          </select>
        </label>
        <label className="field">
          <span>{props.ui.fontSize}</span>
          <input
            type="range"
            min="0.9"
            max="1.2"
            step="0.05"
            value={props.settings.fontScale}
            onChange={(event) => props.onChange("fontScale", event.target.value)}
          />
        </label>
        <label className="field">
          <span>{props.ui.mathDelimiter}</span>
          <input value={props.settings.mathDelimiter} onChange={(event) => props.onChange("mathDelimiter", event.target.value)} />
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={props.settings.autoTranslate === "true"}
            onChange={(event) => props.onChange("autoTranslate", String(event.target.checked))}
          />
          <span>{props.ui.autoTranslate}</span>
        </label>
        <label className="field">
          <span>{props.ui.aiProvider}</span>
          <select
            value={provider}
            onChange={(event) => {
              const nextProvider = normalizeAiProviderKind(event.target.value);
              props.onChange("aiProvider", nextProvider);
              props.onChange("aiModel", aiModelForProvider(props.settings, nextProvider));
            }}
          >
            <option value="codex-cli">Codex CLI</option>
            <option value="claude-code">Claude Code{claudeMissing ? props.ui.claudeMissingSuffix : ""}</option>
            <option value="local-draft">Local draft</option>
          </select>
          {providerStatus && provider !== "local-draft" && (
            <p className={`provider-status ${providerStatus.installed === false ? "provider-status-error" : ""}`}>
              <strong>{providerStatusLabel}</strong>
              <span>
                {providerStatus.installed === true
                  ? providerStatus.source ?? providerStatus.command ?? providerStatusMessage
                  : providerStatus.installed === null
                    ? providerStatusMessage
                  : provider === "claude-code"
                    ? props.ui.claudeMissingHelp
                    : providerStatusMessage}
              </span>
            </p>
          )}
        </label>
        <label className="field model-field">
          <span>{props.ui.model}</span>
          <select
            value={selectedModel}
            disabled={provider === "local-draft"}
            onChange={(event) => setSelectedModel(event.target.value)}
          >
            <option value="">{props.ui.providerDefault}</option>
            {!selectedModelIsKnown && selectedModel && <option value={selectedModel}>Custom: {selectedModel}</option>}
            {modelOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <input
            className="model-custom-input"
            placeholder="custom model id"
            value={selectedModel}
            disabled={provider === "local-draft"}
            onChange={(event) => setSelectedModel(event.target.value)}
          />
        </label>
        {provider === "codex-cli" && (
          <label className="field">
            <span>{props.ui.reasoningEffort || "Reasoning effort"}</span>
            <select
              value={selectedCodexReasoningEffort(props.settings)}
              onChange={(event) => {
                props.onChange("codexReasoningEffort", event.target.value);
              }}
            >
              {codexReasoningEffortOptions.map((option) => (
                <option key={option.value || "default"} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{props.ui.bridgePath}</span>
          <input value={props.settings.bridgePath} onChange={(event) => props.onChange("bridgePath", event.target.value)} />
        </label>
        <label className="field wide-field">
          <span>{props.ui.customPrompt}</span>
          <textarea value={props.settings.customPrompt} onChange={(event) => props.onChange("customPrompt", event.target.value)} />
        </label>
      </div>
      <div className="runtime-card">
        <Bot size={20} />
        <div>
          <strong>{props.runtime}</strong>
          <span>{props.ui.runtimeHint}</span>
        </div>
      </div>
      <div className="danger-card">
        <Trash2 size={20} />
        <div>
          <strong>{props.ui.resetTitle}</strong>
          <span>{props.ui.resetDescription}</span>
        </div>
        <button onClick={props.onResetWorkspace}>{props.ui.resetAction}</button>
      </div>
    </section>
  );
}

export default App;
