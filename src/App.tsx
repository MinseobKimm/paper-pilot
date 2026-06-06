import { Upload } from "./components/icons";
import { FloatingAiCard } from "./components/panels/FloatingAiCard";
import { LinkPreviewModal } from "./components/panels/LinkPreviewModal";
import type { ReaderAssistantMode } from "./components/panels/ReaderPanels";
import { ReaderWorkspace } from "./components/reader/ReaderWorkspace";
import { SelectionToolbarView } from "./components/reader/SelectionToolbarView";
import { SettingsView } from "./components/settings/SettingsView";
import { LibraryManagerView } from "./components/LibraryViews";
import { WordMeaningPopup } from "./components/ReaderChrome";
import { TopToolbar } from "./components/TopToolbar";
import { useActiveDocumentData } from "./hooks/useActiveDocumentData";
import { useAppStartup } from "./hooks/useAppStartup";
import { useBridgeResults } from "./hooks/useBridgeResults";
import { useDocumentActions } from "./hooks/useDocumentActions";
import { useLibraryController } from "./hooks/useLibraryController";
import { usePagePersistence } from "./hooks/usePagePersistence";
import { useReaderAutomation } from "./hooks/useReaderAutomation";
import { useWordMeaningController } from "./hooks/useWordMeaningController";
import { useReaderLayout } from "./hooks/useReaderLayout";
import { useReaderSelection } from "./hooks/useReaderSelection";
import { useReaderViewportSync } from "./hooks/useReaderViewportSync";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PdfDocumentProxy } from "./lib/pdfDocument";
import { isAgentProvider, normalizeAiProviderKind, runAiTask } from "./lib/ai";
import { makeId, nowIso } from "./lib/ids";
import {
  inferPdfTitleFromPdfItems,
  inferPageTextLayoutFromPdfItems,
  pageTextFromPdfItems,
  type DocumentTextLayoutMode,
  type PageTextLayoutInference,
} from "./lib/pdfText";
import {
  clampNumber,
  defaultReaderZoom,
  documentReaderBookmarksSettingKey,
  pageTextLayoutConfidenceSettingKey,
  pageTextLayoutSettingKey,
  pageTextLayoutSourceSettingKey,
  readerBookmarksFromSettings,
  type ReaderBookmark,
} from "./lib/readerSettings";
import {
  buildDocumentContextPack,
  type OutlineAnchor,
  type OutlineRow,
} from "./lib/outlines";
import {
  hasBlockingPendingTranslation,
  hasTranslationRequestForPage,
  parseTranslationLines,
  sentenceUnitsForPage,
  smartSentenceParts,
  stalePendingTranslationMs,
  translationRequestKey,
  translationResultsForPage,
} from "./lib/translations";
import {
  flattenPdfOutlineRows,
  type PdfOutlineItem,
} from "./lib/linkPreviews";
import { normalizeComparable } from "./lib/textUtils";
import {
  UiStringsContext,
  translationLanguageLabel,
  translationLanguageNameFromSettings,
  translationLanguageOption,
} from "./lib/uiStrings";
import {
  selectedAiModel,
  selectedAiModelForRun,
  selectedCodexReasoningEffort,
} from "./lib/aiPreferences";
import {
  displayWordMeaningEntries,
  normalizeWordKey,
} from "./lib/wordMeanings";
import { inferYear, initialState, wordMeaningLookupEnabled } from "./lib/appState";
import {
  chatInputTextWithMode,
  getReadableAiOutput,
  latestProviderSessionId,
  stripChatAskPrefix,
  taskTitle,
  wordMeaningTaskType,
} from "./lib/aiResults";
import { compactUiText } from "./lib/fileActions";
import { readingStatusSettingKey, type ReadingStatus } from "./lib/readingStatus";
import {
  deleteAiResults,
  importPdf,
  isTauriRuntime,
  readDocumentBytes,
  resetWorkspaceFiles,
  savePages,
  setSetting,
  startBridgeWorker,
  updateDocument,
  upsertNote,
} from "./lib/tauri";
import type {
  AiResultRecord,
  AgentProviderStatus,
  AiProviderKind,
  AiTaskType,
  AnnotationRecord,
  AppStateRecord,
  DocumentRecord,
  PageRecord,
  PanelTab,
  DocumentContextPack,
  WorkspaceMode,
} from "./types";

(pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
  pdfWorkerUrl;

type ToastMessage = {
  message: string;
  kind: "info" | "error";
};

const agentParallelTaskLimit = 3;

function importedFileTitle(fileName: string) {
  return fileName
    .replace(/\.pdf$/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanPaperTitleCandidate(value: string) {
  const title = value
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.pdf$/i, "")
    .trim();
  if (title.length < 6 || title.length > 260) {
    return "";
  }
  if (/^(untitled|document|paper|abstract|introduction)$/i.test(title)) {
    return "";
  }
  return title;
}

function shouldUseAutomaticTitle(document: DocumentRecord) {
  const current = cleanPaperTitleCandidate(document.title);
  const imported = cleanPaperTitleCandidate(importedFileTitle(document.fileName));
  return !current || normalizeComparable(current) === normalizeComparable(imported);
}

function automaticPaperTitle(metadataTitle: string | undefined, inferredTitle: string, fileName: string) {
  const inferred = cleanPaperTitleCandidate(inferredTitle);
  const metadata = cleanPaperTitleCandidate(metadataTitle ?? "");
  const imported = cleanPaperTitleCandidate(importedFileTitle(fileName));
  const metadataLooksLikeFile =
    !metadata ||
    normalizeComparable(metadata) === normalizeComparable(imported) ||
    /^(microsoft word|untitled|document)\b/i.test(metadata) ||
    /\.(docx?|tex|pdf)$/i.test(metadata);
  return inferred || (metadataLooksLikeFile ? "" : metadata);
}

type ViewportRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

function App() {
  const [state, setState] = useState<AppStateRecord>(initialState);
  const [mode, setMode] = useState<WorkspaceMode>("library");
  const modeBeforeSettingsRef = useRef<Exclude<WorkspaceMode, "settings">>("library");
  const [activePanel, setActivePanel] = useState<PanelTab>("ai");
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PdfDocumentProxy | null>(null);
  const [loadedDocumentId, setLoadedDocumentId] = useState<string | null>(null);
  const [loadedBytes, setLoadedBytes] = useState<Uint8Array | null>(null);
  const [pageImages, setPageImages] = useState<Record<number, string>>({});
  const [pageCursor, setPageCursor] = useState(1);
  const [searchTerm, setSearchTerm] = useState("");
  const [hoverSource, setHoverSource] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [outlineCompact, setOutlineCompact] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const [assistantMode, setAssistantMode] = useState<ReaderAssistantMode>("study");
  const [floatingResultId, setFloatingResultId] = useState<string | null>(null);
  const [floatingAvoidRect, setFloatingAvoidRect] = useState<ViewportRect | null>(null);
  const [selectedSentenceId, setSelectedSentenceId] = useState<string | null>(null);
  const [translationEligiblePages, setTranslationEligiblePages] = useState<Set<number>>(() => new Set([1]));
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  const [translationPanelOpen, setTranslationPanelOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Partial<Record<AiProviderKind, AgentProviderStatus>>>({});
  const [isBusy, setIsBusy] = useState(false);
  const [pdfOutlineRows, setPdfOutlineRows] = useState<OutlineRow[]>([]);
  const [pageOutlineAnchors, setPageOutlineAnchors] = useState<Record<number, OutlineAnchor[]>>({});
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const translationRequestsRef = useRef<Map<string, number>>(new Map());
  const autoHighlightRequestsRef = useRef<Map<string, number>>(new Map());
  const incompleteTranslationRetriesRef = useRef<Map<string, number>>(new Map());
  const outlineRequestsRef = useRef<Set<string>>(new Set());
  const documentLayoutRequestsRef = useRef<Set<string>>(new Set());

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

  useAppStartup({
    setState,
    setActiveDocumentId,
    setAgentStatuses,
    showToast,
  });

  const {
    activeDocument,
    activePages,
    activePageTextLayoutModes,
    currentPage,
    wordMeaningMap,
    activeDocumentWordList,
    missingWordCount,
    activeAnnotations,
    activeAiResults,
    uiLanguage,
    ui,
    translationLanguageName,
    currentTranslationUnits,
    selectedSentenceIds,
    activeOutlineRows,
    activeCitations,
    activeNote,
    floatingResult,
    bridgePath,
    savedHorizontalScrollLeft,
  } = useActiveDocumentData({
    state,
    activeDocumentId,
    pageCursor,
    selectedSentenceId,
    pageOutlineAnchors,
    pdfOutlineRows,
    floatingResultId,
  });

  const {
    zoom,
    readerLayout,
    readerGridStyle,
    commitZoom,
    startLayoutResize,
  } = useReaderLayout(state.settings, activeDocumentId, patchState);
  const activeReaderBookmarks = useMemo(
    () => readerBookmarksFromSettings(state.settings, activeDocumentId),
    [activeDocumentId, state.settings],
  );
  const activePdfDocument = activeDocumentId && activeDocumentId === loadedDocumentId ? pdfDocument : null;

  useEffect(() => {
    if (!activeDocumentId || activeDocumentId !== loadedDocumentId || !state.documents.some((document) => document.id === activeDocumentId)) {
      setPdfDocument(null);
      setLoadedDocumentId(null);
      setLoadedBytes(null);
      setPageImages({});
      setPdfOutlineRows([]);
      setPageOutlineAnchors({});
      setActiveOutlineId(null);
    }
  }, [activeDocumentId, loadedDocumentId, state.documents]);

  const {
    libraryQuery,
    setLibraryQuery,
    folderFilter,
    setFolderFilter,
    newFolderName,
    setNewFolderName,
    selectedDocumentIds,
    setSelectedDocumentIds,
    filteredDocuments,
    createFolder,
    moveActiveDocument,
    renameFolder,
    createChildFolder,
    deleteFolderTree,
    moveDocumentsToFolder,
    deleteDocumentsFromLibrary,
    toggleLibraryDocumentSelection,
    toggleDocumentBookmark,
    renameDocumentTitle,
  } = useLibraryController({
    state,
    patchState,
    ui,
    activeDocument,
    activeDocumentId,
    setActiveDocumentId,
    setPdfDocument,
    setLoadedBytes,
    setPageImages,
    setPdfOutlineRows,
    setPageOutlineAnchors,
    setActiveOutlineId,
    setMode,
    showToast,
  });

  async function persistPageTextLayoutInference(
    documentId: string,
    pageNumber: number,
    inference: PageTextLayoutInference,
    source: "local" | "ai" = "local",
  ) {
    const layoutKey = pageTextLayoutSettingKey(documentId, pageNumber);
    const confidenceKey = pageTextLayoutConfidenceSettingKey(documentId, pageNumber);
    const sourceKey = pageTextLayoutSourceSettingKey(documentId, pageNumber);
    const confidence = String(Math.max(0, Math.min(1, inference.confidence)));
    patchState((draft) => {
      draft.settings[layoutKey] = inference.mode;
      draft.settings[confidenceKey] = confidence;
      draft.settings[sourceKey] = source;
    });
    await Promise.all([
      setSetting(layoutKey, inference.mode),
      setSetting(confidenceKey, confidence),
      setSetting(sourceKey, source),
    ]);
  }

  function rememberPageTextLayout(documentId: string, pageNumber: number, inference: PageTextLayoutInference) {
    const layoutKey = pageTextLayoutSettingKey(documentId, pageNumber);
    const confidenceKey = pageTextLayoutConfidenceSettingKey(documentId, pageNumber);
    const sourceKey = pageTextLayoutSourceSettingKey(documentId, pageNumber);
    const existingSource = state.settings[sourceKey] || "";
    const existingConfidence = Number(state.settings[confidenceKey] || "0");
    if (existingSource === "ai") {
      return;
    }
    if (state.settings[layoutKey] === inference.mode && Number.isFinite(existingConfidence) && existingConfidence >= inference.confidence) {
      return;
    }
    void persistPageTextLayoutInference(documentId, pageNumber, inference).catch((error) =>
      showToast(`${ui.aiTaskFailedPrefix}: ${String(error)}`, "error"),
    );
  }

  async function loadPdfBytes(document: DocumentRecord, bytes?: Uint8Array) {
    setMode("reader");
    if (!bytes && activeDocumentId === document.id && loadedDocumentId === document.id && pdfDocument) {
      setPageCursor(1);
      return;
    }
    setIsBusy(true);
    setActiveDocumentId(document.id);
    setPageCursor(1);
    try {
      const pdfBytes = bytes ?? (await readDocumentBytes(document.id));
      setLoadedBytes(pdfBytes);
      setPageImages({});
      setPdfOutlineRows([]);
      setPageOutlineAnchors({});
      setActiveOutlineId(null);
      const loadingTask = (pdfjsLib as unknown as { getDocument(options: { data: Uint8Array }): { promise: Promise<PdfDocumentProxy> } }).getDocument({
        data: pdfBytes,
      });
      const pdf = await loadingTask.promise;

      const [metadata, outline] = await Promise.all([
        pdf.getMetadata().catch(() => ({ info: {} })),
        pdf.getOutline().catch(() => null),
      ]);
      const mappedOutlineRows = outline?.length ? await flattenPdfOutlineRows(pdf, outline, pdf.numPages) : [];
      setPdfOutlineRows(mappedOutlineRows);
      const info = (metadata.info ?? {}) as { Title?: string; Author?: string; CreationDate?: string };
      let inferredTitle = "";
      const shouldUpdateTitle = shouldUseAutomaticTitle(document);
      if (shouldUpdateTitle || pdf.numPages > 0) {
        const sampleLimit = Math.min(pdf.numPages, 5);
        for (let pageNumber = 1; pageNumber <= sampleLimit; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          const viewport = page.getViewport({ scale: defaultReaderZoom });
          const content = await page.getTextContent();
          if (pageNumber === 1 && shouldUpdateTitle) {
            inferredTitle = inferPdfTitleFromPdfItems(content.items, viewport, defaultReaderZoom);
          }
          const inference = inferPageTextLayoutFromPdfItems(content.items, viewport, defaultReaderZoom);
          await persistPageTextLayoutInference(document.id, pageNumber, inference);
        }
      }
      const automaticTitle = shouldUpdateTitle ? automaticPaperTitle(info.Title, inferredTitle, document.fileName) : "";
      const updated: DocumentRecord = {
        ...document,
        title: automaticTitle || document.title,
        authors: info.Author || document.authors,
        year: document.year || inferYear(info.CreationDate),
        pageCount: pdf.numPages,
      };
      const shouldSaveMetadata =
        updated.title !== document.title ||
        updated.authors !== document.authors ||
        updated.year !== document.year ||
        updated.pageCount !== document.pageCount;
      if (shouldSaveMetadata) {
        const saved = await updateDocument({ ...updated, updatedAt: nowIso() });
        patchState((draft) => {
          draft.documents = draft.documents.map((item) => (item.id === saved.id ? saved : item));
        });
      }
      setLoadedDocumentId(document.id);
      setPdfDocument(pdf);
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

  async function extractOrderedPagesFromPdf(document: DocumentRecord, pdf: PdfDocumentProxy): Promise<PageRecord[]> {
    const extracted: PageRecord[] = [];
    const cached = new Map<
      number,
      {
        page: Awaited<ReturnType<PdfDocumentProxy["getPage"]>>;
        viewport: ReturnType<Awaited<ReturnType<PdfDocumentProxy["getPage"]>>["getViewport"]>;
        content: Awaited<ReturnType<Awaited<ReturnType<PdfDocumentProxy["getPage"]>>["getTextContent"]>>;
      }
    >();
    const pageInferences = new Map<number, PageTextLayoutInference>();
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const cachedPage = cached.get(pageNumber);
      const page = cachedPage?.page ?? (await pdf.getPage(pageNumber));
      const viewport = cachedPage?.viewport ?? page.getViewport({ scale: defaultReaderZoom });
      const content = cachedPage?.content ?? (await page.getTextContent());
      const inference = pageInferences.get(pageNumber) ?? inferPageTextLayoutFromPdfItems(content.items, viewport, defaultReaderZoom);
      pageInferences.set(pageNumber, inference);
      await persistPageTextLayoutInference(document.id, pageNumber, inference);
      const text = pageTextFromPdfItems(content.items, viewport, defaultReaderZoom, inference.mode || "auto");
      extracted.push({
        documentId: document.id,
        pageNumber,
        text,
        outlineLabel: text.split(/[.!?]\s+/)[0]?.slice(0, 90) || `Page ${pageNumber}`,
      });
    }
    return extracted;
  }

  async function replaceExtractedPages(documentId: string, pages: PageRecord[]) {
    await savePages(documentId, pages);
    patchState((draft) => {
      draft.pages = draft.pages.filter((page) => page.documentId !== documentId).concat(pages);
    });
    void persistWordListForPages(documentId, pages).catch((error) =>
      showToast(`${ui.aiTaskFailedPrefix}: ${String(error)}`, "error"),
    );
  }

  async function ensureActivePages(): Promise<PageRecord[]> {
    if (!activeDocument) {
      return [];
    }
    const expectedPageCount = Math.max(1, activePdfDocument?.numPages ?? activeDocument.pageCount ?? activePages.length);
    const needsFormulaRefresh = activePages.some((page) =>
      /\(\d+\)/.test(page.text) &&
      /(?:Jmn|dLdZ|dLdA|∂|sigma|softmax|erf|Φ|Phi)/i.test(page.text) &&
      !page.text.includes("Extracted equations:"),
    );
    if (activePages.length >= expectedPageCount && !needsFormulaRefresh) {
      return activePages;
    }
    if (!activePdfDocument) {
      return activePages;
    }
    const extracted = await extractOrderedPagesFromPdf(activeDocument, activePdfDocument);
    await replaceExtractedPages(activeDocument.id, extracted);
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
    const providerKind = normalizeAiProviderKind(state.settings.aiProvider);
    const optimisticChatId =
      taskType === "chatWithPaper" && typeof payload.question === "string" ? makeId("chat-pending") : "";
    if (optimisticChatId) {
      const requestedAskMode = typeof payload.askMode === "string" ? payload.askMode : "auto";
      const askMode = requestedAskMode === "direct" ? "deep" : requestedAskMode;
      const question = typeof payload.question === "string" ? payload.question.trim() : "";
      patchState((draft) => {
        draft.aiResults = [
          {
            id: optimisticChatId,
            documentId: activeDocument.id,
            taskType,
            inputText: chatInputTextWithMode(question, askMode),
            outputText: "",
            status: "pending",
            createdAt: nowIso(),
            provider: providerKind,
            model: selectedAiModelForRun(state.settings),
          },
          ...draft.aiResults.filter((item) => item.id !== optimisticChatId),
        ];
      });
      setAssistantMode("study");
      if (!options.keepPanel) {
        setActivePanel("ai");
      }
    }
    try {
      const needsPages =
        ["summarizePaper", "chatWithPaper", "autoHighlight", "outlineDocument", "classifyDocumentLayout", wordMeaningTaskType].includes(taskType) ||
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
        const askMode = typeof taskPayload.askMode === "string" ? taskPayload.askMode : "auto";
        taskPayload.documentContextPack = contextPack;
        taskPayload.askMode = askMode === "direct" ? "deep" : askMode;
      }
      if (taskType === "translatePage" && !taskPayload.text && typeof taskPayload.page === "number") {
        taskPayload.text = pages.find((page) => page.pageNumber === taskPayload.page)?.text ?? "";
      }
      const explicitProviderSessionId =
        typeof taskPayload.providerSessionId === "string" ? taskPayload.providerSessionId : "";
      const reusableSessionResults =
        taskType === "chatWithPaper"
          ? activeAiResults.filter((result) => result.taskType.toString() === "chatWithPaper")
          : activeAiResults;
      const providerSessionId = explicitProviderSessionId || latestProviderSessionId(reusableSessionResults, providerKind);
      const queued = await runAiTask(providerKind, bridgePath, taskType, activeDocument, {
        ...taskPayload,
        customPrompt: state.settings.customPrompt,
        mathDelimiter: state.settings.mathDelimiter,
        model: selectedAiModelForRun(state.settings),
        reasoningEffort: providerKind === "codex-cli" ? selectedCodexReasoningEffort(state.settings) : "",
        providerSessionId,
      });
      patchState((draft) => {
        draft.aiResults = [queued, ...draft.aiResults.filter((item) => item.id !== queued.id && item.id !== optimisticChatId)];
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
      if (optimisticChatId) {
        patchState((draft) => {
          draft.aiResults = draft.aiResults.map((item) =>
            item.id === optimisticChatId
              ? {
                  ...item,
                  outputText: String(error),
                  status: "failed",
                }
              : item,
          );
        });
      }
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

  const {
    scheduleHorizontalScrollSave,
    rememberOutlineAnchors,
    goToPage,
    goToOutlineRow,
    restoreReaderBookmark,
    scheduleReaderCursorSync,
  } = useReaderViewportSync({
    readerRef,
    mode,
    activeDocumentId,
    activeDocument,
    activePages,
    pdfDocument: activePdfDocument,
    zoom,
    outlineOpen,
    translationPanelOpen,
    rightPanelOpen,
    readerLayout,
    savedHorizontalScrollLeft,
    activeOutlineRows,
    patchState,
    setPageCursor,
    setActiveOutlineId,
    setPageOutlineAnchors,
    setTranslationEligiblePages,
    queueAutoTranslationForPageNumber,
  });

  function persistReaderBookmarks(documentId: string, bookmarks: ReaderBookmark[]) {
    const key = documentReaderBookmarksSettingKey(documentId);
    const value = JSON.stringify(bookmarks);
    patchState((draft) => {
      draft.settings[key] = value;
    });
    void setSetting(key, value);
  }

  function addReaderBookmark() {
    if (!activeDocumentId || !activePdfDocument) {
      showToast(ui.openPdfFirst);
      return;
    }
    const element = readerRef.current;
    if (!element) {
      showToast(ui.openPdfFirst);
      return;
    }
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const scrollTop = Math.max(0, Math.round(element.scrollTop));
    const scrollLeft = Math.max(0, Math.round(element.scrollLeft));
    const samePositionBookmarks = activeReaderBookmarks.filter(
      (bookmark) =>
        bookmark.page === pageCursor &&
        Math.abs(bookmark.zoom - zoom) < 0.001 &&
        bookmark.scrollTop === scrollTop &&
        bookmark.scrollLeft === scrollLeft,
    );
    if (samePositionBookmarks.length > 0) {
      const removedIds = new Set(samePositionBookmarks.map((bookmark) => bookmark.id));
      persistReaderBookmarks(
        activeDocumentId,
        activeReaderBookmarks.filter((bookmark) => !removedIds.has(bookmark.id)),
      );
      showToast(ui.readerBookmarkDeleted);
      return;
    }
    const bookmark: ReaderBookmark = {
      id: makeId("reader-bookmark"),
      documentId: activeDocumentId,
      page: pageCursor,
      zoom,
      scrollTop,
      scrollLeft,
      scrollRatio: maxTop > 0 ? Math.max(0, Math.min(1, element.scrollTop / maxTop)) : 0,
      createdAt: nowIso(),
    };
    persistReaderBookmarks(activeDocumentId, [...activeReaderBookmarks, bookmark].slice(-80));
    showToast(ui.readerBookmarkSaved);
  }

  function goToReaderBookmark(bookmark: ReaderBookmark) {
    if (!activeDocumentId || bookmark.documentId !== activeDocumentId) {
      return;
    }
    commitZoom(bookmark.zoom);
    restoreReaderBookmark(bookmark);
  }

  function captureReaderZoomAnchor() {
    const element = readerRef.current;
    if (!element) {
      return null;
    }
    const shells = Array.from(element.querySelectorAll<HTMLElement>(".pdf-page-shell"));
    if (shells.length === 0) {
      return null;
    }
    const containerBox = element.getBoundingClientRect();
    const centerX = containerBox.left + element.clientWidth / 2;
    const centerY = containerBox.top + element.clientHeight / 2;
    const target =
      shells.find((shell) => {
        const box = shell.getBoundingClientRect();
        return box.top <= centerY && box.bottom >= centerY;
      }) ??
      shells
        .map((shell) => {
          const box = shell.getBoundingClientRect();
          return { shell, distance: Math.min(Math.abs(box.top - centerY), Math.abs(box.bottom - centerY)) };
        })
        .sort((a, b) => a.distance - b.distance)[0]?.shell;
    if (!target) {
      return null;
    }
    const targetBox = target.getBoundingClientRect();
    return {
      page: Number(target.dataset.page ?? pageCursor) || pageCursor,
      xRatio: clampNumber((centerX - targetBox.left) / Math.max(1, targetBox.width), 0, 1),
      yRatio: clampNumber((centerY - targetBox.top) / Math.max(1, targetBox.height), 0, 1),
    };
  }

  function restoreReaderZoomAnchor(anchor: ReturnType<typeof captureReaderZoomAnchor>) {
    if (!anchor) {
      return;
    }
    const apply = () => {
      const element = readerRef.current;
      const target = document.getElementById(`page-${anchor.page}`) as HTMLElement | null;
      if (!element || !target) {
        return;
      }
      const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
      const maxLeft = Math.max(0, element.scrollWidth - element.clientWidth);
      const top = target.offsetTop + target.offsetHeight * anchor.yRatio - element.clientHeight / 2;
      const left = target.offsetLeft + target.offsetWidth * anchor.xRatio - element.clientWidth / 2;
      element.scrollTo({
        top: clampNumber(top, 0, maxTop),
        left: clampNumber(left, 0, maxLeft),
        behavior: "auto",
      });
      scheduleReaderCursorSync(element);
    };
    window.requestAnimationFrame(() => {
      apply();
      window.requestAnimationFrame(apply);
      window.setTimeout(apply, 120);
    });
  }

  function commitZoomKeepingView(nextZoom: number) {
    const anchor = captureReaderZoomAnchor();
    commitZoom(nextZoom);
    restoreReaderZoomAnchor(anchor);
  }

  function deleteReaderBookmark(bookmarkId: string) {
    if (!activeDocumentId) {
      return;
    }
    persistReaderBookmarks(
      activeDocumentId,
      activeReaderBookmarks.filter((bookmark) => bookmark.id !== bookmarkId),
    );
    showToast(ui.readerBookmarkDeleted);
  }

  const {
    linkPreview,
    linkPreviewLoading,
    setLinkPreview,
    setLinkPreviewLoading,
    extractCitationCards,
    resolveCitationLinks,
    updateMetadata,
    deleteAnnotationById,
    deleteAllActiveAnnotations,
    deleteExplanationResult,
    openExplanation,
    openLinkPreview,
    goToLinkPreviewTarget,
    summarizeLinkPreview,
    saveNote,
    deleteActiveNote,
    exportJson,
    exportZip,
    shareAnnotatedFile,
  } = useDocumentActions({
    state,
    activeDocument,
    activePages,
    activeCitations,
    activeAnnotations,
    activeAiResults,
    activeNote,
    floatingResultId,
    pdfDocument: activePdfDocument,
    pageImages,
    translationLanguageName,
    ui,
    uiLanguage,
    patchState,
    showToast,
    queueTask,
    goToPage,
    ensureActivePages,
    setIsBusy,
    setActivePanel,
    setFloatingResultId,
    setRightPanelOpen,
  });

  const {
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
  } = useReaderSelection({
    activeDocument,
    activePages,
    ui,
    uiLanguage,
    patchState,
    showToast,
    queueTask,
    copyText,
    onExplanationAnchor: (rect) => setFloatingAvoidRect(rect ?? null),
  });

  const {
    wordPopup,
    setWordPopup,
    wordLookupLoadingKey,
    persistWordListForPages,
    saveWordMeaningsFromResult,
    saveDocumentLayoutFromResult,
    deleteWordMeaningEntry,
    queueMissingWordMeanings,
    queueAdjustedWordMeaning,
    openWordMeaningPopup,
  } = useWordMeaningController({
    state,
    activeDocument,
    activePages,
    activeDocumentWordList,
    wordMeaningMap,
    markupToolKind: markupTool.kind,
    ui,
    uiLanguage,
    patchState,
    showToast,
    queueTask,
    ensureActivePages,
  });

  async function queueDeepReadAfterInsufficientFast(result: AiResultRecord, metadata: Record<string, unknown>) {
    const payload = metadata.payload && typeof metadata.payload === "object" ? (metadata.payload as Record<string, unknown>) : {};
    if (payload.askMode !== "fast" || payload.evidenceSufficient !== false) {
      return;
    }
    const englishQuestion =
      typeof payload.englishQuestion === "string" && payload.englishQuestion.trim()
        ? payload.englishQuestion.trim()
        : stripChatAskPrefix(result.inputText);
    const originalQuestion =
      typeof payload.originalQuestion === "string" && payload.originalQuestion.trim()
        ? payload.originalQuestion.trim()
        : stripChatAskPrefix(result.inputText);
    const duplicateQuestions = new Set([englishQuestion, originalQuestion].filter(Boolean));
    const hasDuplicatePendingDeepRead = activeAiResults.some(
      (item) =>
        item.status === "pending" &&
        item.taskType.toString() === "chatWithPaper" &&
        duplicateQuestions.has(stripChatAskPrefix(item.inputText)),
    );
    if (hasDuplicatePendingDeepRead) {
      return;
    }
    await queueTask(
      "chatWithPaper",
      {
        question: englishQuestion,
        englishQuestion,
        originalQuestion,
        askMode: "deep",
        triggeredBy: "fast-insufficient",
        parentResultId: result.id,
      },
      { silent: true, keepPanel: true },
    );
  }

  const {
    saveLocalAiResult,
    saveAutoHighlightsFromResult,
    pollBridge,
    runPendingBridgeWorkers,
  } = useBridgeResults({
    activeDocument,
    activePages,
    activeAnnotations,
    activeAiResults,
    bridgePath,
    pageCursor,
    ui,
    uiLanguage,
    patchState,
    showToast,
    translationRequestsRef,
    setFloatingResultId,
    saveWordMeaningsFromResult,
    saveDocumentLayoutFromResult,
    onFastEvidenceInsufficient: queueDeepReadAfterInsufficientFast,
  });

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

  const {
    createPageText,
    rememberPageImage,
    runAutoHighlightForCurrentPage,
  } = usePagePersistence({
    state,
    activeDocument,
    activePages,
    activeAnnotations,
    activeAiResults,
    pageCursor,
    translationEligiblePages,
    autoHighlightRequestsRef,
    ui,
    uiLanguage,
    patchState,
    setState,
    showToast,
    setPageImages,
    queueTranslationForPage,
    persistWordListForPages,
    ensureActivePages,
    queueTask,
  });

  useReaderAutomation({
    state,
    activeDocument,
    activeDocumentId,
    pdfDocument: activePdfDocument,
    activePages,
    activeAiResults,
    activeAnnotations,
    pageCursor,
    translationEligiblePages,
    incompleteTranslationRetriesRef,
    outlineRequestsRef,
    documentLayoutRequestsRef,
    setSelectedSentenceId,
    setWordPopup,
    setSelectionToolbar,
    setTextSelectionPreview,
    setTranslationEligiblePages,
    queueTranslationForPage,
    queueTask,
    extractOrderedPagesFromPdf,
    replaceExtractedPages,
    saveDocumentLayoutFromResult,
    runAutoHighlightForCurrentPage,
    patchState,
    agentParallelTaskLimit,
  });

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
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
      setLoadedDocumentId(null);
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

  const pageMatches = useMemo(() => {
    if (!searchTerm.trim()) {
      return [];
    }
    const query = searchTerm.toLowerCase();
    return activePages.filter((page) => page.text.toLowerCase().includes(query)).map((page) => page.pageNumber);
  }, [activePages, searchTerm]);

  useEffect(() => {
    if (mode !== "settings") {
      modeBeforeSettingsRef.current = mode;
    }
  }, [mode]);

  useEffect(() => {
    if (mode === "reader") {
      return;
    }
    setFloatingResultId(null);
    setFloatingAvoidRect(null);
    setSelectionToolbar(null);
    setTextSelectionPreview(null);
  }, [mode, setSelectionToolbar, setTextSelectionPreview]);

  function toggleSettingsMode() {
    setWordPopup(null);
    setMode((current) => {
      if (current !== "settings") {
        modeBeforeSettingsRef.current = current;
        return "settings";
      }
      return modeBeforeSettingsRef.current === "reader" && !activeDocument ? "library" : modeBeforeSettingsRef.current;
    });
  }

  function openLibraryMode() {
    setWordPopup(null);
    setMode("library");
  }

  async function saveLibraryDocumentDetails(document: DocumentRecord, markdown: string, readingStatus: ReadingStatus) {
    const timestamp = nowIso();
    const key = readingStatusSettingKey(document.id);
    const existingNote = state.notes.find((note) => note.documentId === document.id);
    const note = await upsertNote({
      id: existingNote?.id ?? `note-${document.id}`,
      documentId: document.id,
      markdown,
      updatedAt: timestamp,
    });
    await setSetting(key, readingStatus);
    patchState((draft) => {
      draft.notes = [note, ...draft.notes.filter((item) => item.id !== note.id)];
      draft.settings[key] = readingStatus;
    });
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
          pageCount={activePdfDocument?.numPages ?? activeDocument?.pageCount ?? 0}
          searchTerm={searchTerm}
          busy={isBusy}
          outlineOpen={outlineOpen}
          rightPanelOpen={rightPanelOpen}
          shareReady={Boolean(activeDocument && (activePdfDocument || Object.keys(pageImages).length > 0))}
          onOpenLibrary={openLibraryMode}
          onOpenSettings={toggleSettingsMode}
          onZoomIn={() => commitZoomKeepingView(zoom + 0.1)}
          onZoomOut={() => commitZoomKeepingView(zoom - 0.1)}
          onPageChange={(page) => goToPage(page)}
          onSearch={setSearchTerm}
          onTogglePanel={() => setRightPanelOpen((value) => !value)}
          onToggleTranslationPanel={() => setTranslationPanelOpen((value) => !value)}
          onZoomChange={commitZoomKeepingView}
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
            notes={state.notes}
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
            onRenameDocument={(document) => void renameDocumentTitle(document)}
            onSaveDocumentDetails={saveLibraryDocumentDetails}
          />
        )}

        {mode === "reader" && (
          <ReaderWorkspace
            ui={ui}
            state={state}
            activePanel={activePanel}
            setActivePanel={setActivePanel}
            activeDocument={activeDocument}
            activePages={activePages}
            activeAnnotations={activeAnnotations}
            activeAiResults={activeAiResults}
            activeCitations={activeCitations}
            activeNote={activeNote}
            activeOutlineRows={activeOutlineRows}
            activeOutlineId={activeOutlineId}
            activeDocumentWordList={activeDocumentWordList}
            activePageTextLayoutModes={activePageTextLayoutModes}
            currentPage={currentPage}
            currentTranslationUnits={currentTranslationUnits}
            selectedSentenceId={selectedSentenceId}
            selectedSentenceIds={selectedSentenceIds}
            missingWordCount={missingWordCount}
            pdfDocument={activePdfDocument}
            pageCursor={pageCursor}
            pageImages={pageImages}
            pageMatches={pageMatches}
            readerBookmarks={activeReaderBookmarks}
            zoom={zoom}
            searchTerm={searchTerm}
            hoverSource={hoverSource}
            readerRef={readerRef}
            readerGridStyle={readerGridStyle}
            outlineOpen={outlineOpen}
            setOutlineOpen={setOutlineOpen}
            outlineCompact={outlineCompact}
            setOutlineCompact={setOutlineCompact}
            translationPanelOpen={translationPanelOpen}
            setTranslationPanelOpen={setTranslationPanelOpen}
            rightPanelOpen={rightPanelOpen}
            setRightPanelOpen={setRightPanelOpen}
            translationLanguageName={translationLanguageName}
            markupTool={markupTool}
            setMarkupTool={setMarkupTool}
            regionMode={regionMode}
            setRegionMode={setRegionMode}
            regionDrag={regionDrag}
            textSelectionPreview={textSelectionPreview}
            selectionToolbar={selectionToolbar}
            assistantMode={assistantMode}
            setAssistantMode={setAssistantMode}
            chatDraft={chatDraft}
            setChatDraft={setChatDraft}
            folders={state.folders}
            onPickFile={() => fileInputRef.current?.click()}
            onLoadActiveDocument={(document) => void loadPdfBytes(document)}
            onShowToast={showToast}
            onPatchState={patchState}
            onStartLayoutResize={startLayoutResize}
            onGoToPage={goToPage}
            onGoToOutlineRow={goToOutlineRow}
            onAddReaderBookmark={addReaderBookmark}
            onGoToReaderBookmark={goToReaderBookmark}
            onDeleteReaderBookmark={deleteReaderBookmark}
            onSelectSentenceAndScroll={selectSentenceAndScroll}
            onRefreshTranslationForPage={(page) => void refreshTranslationForPage(page)}
            onScheduleHorizontalScrollSave={scheduleHorizontalScrollSave}
            onScheduleReaderCursorSync={scheduleReaderCursorSync}
            onHandleRegionMouseDown={handleRegionMouseDown}
            onHandleRegionMouseMove={handleRegionMouseMove}
            onFinishRegionExplain={finishRegionExplain}
            onCreatePageText={(page) => void createPageText(page)}
            onRememberPageTextLayout={(pageNumber, inference) =>
              activeDocument && rememberPageTextLayout(activeDocument.id, pageNumber, inference)
            }
            onRememberOutlineAnchors={rememberOutlineAnchors}
            onRememberPageImage={rememberPageImage}
            onOpenExplanation={openExplanation}
            onDeleteAnnotationById={(id) => void deleteAnnotationById(id)}
            onOpenLinkPreview={(target) => void openLinkPreview(target)}
            onOpenWordMeaningPopup={openWordMeaningPopup}
            onQueueTask={(type, payload) => void queueTask(type, payload)}
            onRunPendingBridgeWorkers={() => void runPendingBridgeWorkers()}
            onPollBridge={() => void pollBridge()}
            onDeleteAllActiveAnnotations={() => void deleteAllActiveAnnotations()}
            onDeleteExplanationResult={(result) => void deleteExplanationResult(result)}
            onExtractCitationCards={() => void extractCitationCards()}
            onResolveCitationLinks={() => void resolveCitationLinks()}
            onSaveNote={(markdown) => saveNote(markdown)}
            onDeleteActiveNote={() => deleteActiveNote()}
            onUpdateMetadata={updateMetadata}
            onMoveActiveDocument={(folderId) => void moveActiveDocument(folderId)}
            onExportJson={() => void exportJson()}
            onExportZip={() => void exportZip()}
            onCopyText={copyText}
            onHoverSource={setHoverSource}
            onCreateMissingWordMeanings={() => void queueMissingWordMeanings()}
            onShareAnnotatedFile={() => void shareAnnotatedFile()}
            onToggleWordPopupClosed={() => setWordPopup(null)}
          />
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
          avoidRect={floatingAvoidRect}
          onClose={() => {
            setFloatingResultId(null);
            setFloatingAvoidRect(null);
          }}
          onCopy={() => void copyText(getReadableAiOutput(floatingResult, ui), taskTitle(floatingResult.taskType.toString(), ui))}
          onDelete={(result) => {
            setFloatingAvoidRect(null);
            void deleteExplanationResult(result);
          }}
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
          onDeleteEntry={(entryId) => void deleteWordMeaningEntry(wordPopup.word, entryId)}
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

export default App;
