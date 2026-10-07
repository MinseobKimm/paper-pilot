import { ScholarlyProvider } from "./components/ScholarlyWorkspace";
import { DiscoverView } from "./components/DiscoverView";
import { scholarlyInvoke, readerAutomaticMetadata } from "./lib/scholarlyService";
import type { DocumentScholarlyProfile } from "./types/scholarly";
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
import { usePaperCitations } from "./hooks/usePaperCitations";
import { CitationPopover } from "./components/reader/CitationPopover";
import { useWordMeaningController } from "./hooks/useWordMeaningController";
import { useReaderLayout } from "./hooks/useReaderLayout";
import { useReaderSelection } from "./hooks/useReaderSelection";
import { useReaderViewportSync } from "./hooks/useReaderViewportSync";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type SetStateAction } from "react";
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
  documentAutoTranslateSettingKey,
  documentReaderBookmarksSettingKey,
  documentWordMeaningLookupSettingKey,
  lastReaderViewportFromSettings,
  pageTextLayoutConfidenceSettingKey,
  pageTextLayoutSettingKey,
  pageTextLayoutSourceSettingKey,
  readerOutlineCompactSettingKey,
  readerOutlineOpenSettingKey,
  readerBookmarksFromSettings,
  readerRightPanelOpenSettingKey,
  readerTranslationPanelOpenSettingKey,
  settingsBoolean,
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
  wordClickCountsFromSettings,
  normalizeWordKey,
} from "./lib/wordMeanings";
import { inferYear, initialState, wordMeaningLookupEnabled } from "./lib/appState";
import {
  getReadableAiOutput,
  latestProviderSessionId,
  paperChatExcludedResultIds,
  stripChatAskPrefix,
  taskTitle,
  wordMeaningTaskType,
} from "./lib/aiResults";
import { compactUiText } from "./lib/fileActions";
import { readingStatusSettingKey, type ReadingStatus } from "./lib/readingStatus";
import {
  importPdf,
  importPdfPaths,
  obsidianConfigure,
  obsidianPickVault,
  obsidianSyncNow,
  pickPdfs,
  loadLibrary,
  isTauriRuntime,
  readDocumentBytes,
  relinkPdf,
  resetWorkspaceFiles,
  savePages,
  setSetting,
  setSettings,
  startBridgeWorker,
  takeOpenedPdfs,
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
import { installWebKitStreamCompatibility } from "./lib/webkitCompat";
import { pdfTextExtractionVersion, pdfTextExtractionVersionKey } from "./lib/pdfText";

installWebKitStreamCompatibility();
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
  const [startupReady, setStartupReady] = useState(false);
  const finderOpenHandlerRef = useRef<(document: DocumentRecord) => Promise<void>>(async () => {});
  const finderDrainRunningRef = useRef(false);
  const finderDrainRequestedRef = useRef(false);
  const [mode, setMode] = useState<WorkspaceMode>("library");
  const [discoverVisited, setDiscoverVisited] = useState(false);
  useEffect(() => { if (mode === "discover") setDiscoverVisited(true); }, [mode]);
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
  const [outlineCompact, setOutlineCompactState] = useState(() =>
    settingsBoolean(initialState.settings, readerOutlineCompactSettingKey, false),
  );
  const [outlineOpen, setOutlineOpenState] = useState(() =>
    settingsBoolean(initialState.settings, readerOutlineOpenSettingKey, true),
  );
  const [assistantMode, setAssistantMode] = useState<ReaderAssistantMode>("study");
  const [floatingResultId, setFloatingResultId] = useState<string | null>(null);
  const [floatingAvoidRect, setFloatingAvoidRect] = useState<ViewportRect | null>(null);
  const [selectedSentenceId, setSelectedSentenceId] = useState<string | null>(null);
  const [translationEligiblePages, setTranslationEligiblePages] = useState<Set<number>>(() => new Set([1]));
  const [rightPanelOpen, setRightPanelOpenState] = useState(() =>
    settingsBoolean(initialState.settings, readerRightPanelOpenSettingKey, true),
  );
  const [fitPageWithPanel, setFitPageWithPanel] = useState(true);
  const [fittedZoom, setFittedZoom] = useState<number | null>(null);
  const [translationPanelOpen, setTranslationPanelOpenState] = useState(() =>
    settingsBoolean(initialState.settings, readerTranslationPanelOpenSettingKey, false),
  );
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Partial<Record<AiProviderKind, AgentProviderStatus>>>({});
  const [isBusy, setIsBusy] = useState(false);
  const [pdfOutlineRows, setPdfOutlineRows] = useState<OutlineRow[]>([]);
  const [pageOutlineAnchors, setPageOutlineAnchors] = useState<Record<number, OutlineAnchor[]>>({});
  const [activeOutlineId, setActiveOutlineId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const stateRef = useRef(state);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const translationRequestsRef = useRef<Map<string, number>>(new Map());
  const autoHighlightRequestsRef = useRef<Map<string, number>>(new Map());
  const incompleteTranslationRetriesRef = useRef<Map<string, number>>(new Map());
  const outlineRequestsRef = useRef<Set<string>>(new Set());
  const documentLayoutRequestsRef = useRef<Set<string>>(new Set());
  const outlineCompactRef = useRef(outlineCompact);
  const outlineOpenRef = useRef(outlineOpen);
  const rightPanelOpenRef = useRef(rightPanelOpen);
  const translationPanelOpenRef = useRef(translationPanelOpen);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const patchState = useCallback((mutator: (draft: AppStateRecord) => void) => {
    setState((current) => {
      const draft = structuredClone(current) as AppStateRecord;
      mutator(draft);
      return draft;
    });
  }, []);

  const persistReaderBooleanSetting = useCallback(
    (key: string, next: boolean) => {
      const value = next ? "true" : "false";
      if (stateRef.current.settings[key] === value) {
        return;
      }
      stateRef.current = {
        ...stateRef.current,
        settings: {
          ...stateRef.current.settings,
          [key]: value,
        },
      };
      patchState((draft) => {
        draft.settings[key] = value;
      });
      void setSetting(key, value);
    },
    [patchState],
  );

  const setPersistentReaderBoolean = useCallback(
    (
      ref: MutableRefObject<boolean>,
      setter: (value: SetStateAction<boolean>) => void,
      key: string,
      update: SetStateAction<boolean>,
    ) => {
      const next = typeof update === "function" ? (update as (current: boolean) => boolean)(ref.current) : update;
      if (ref.current !== next) {
        ref.current = next;
        persistReaderBooleanSetting(key, next);
      }
      setter(next);
    },
    [persistReaderBooleanSetting],
  );

  const setOutlineCompact = useCallback(
    (update: SetStateAction<boolean>) =>
      setPersistentReaderBoolean(outlineCompactRef, setOutlineCompactState, readerOutlineCompactSettingKey, update),
    [setPersistentReaderBoolean],
  );
  const setOutlineOpen = useCallback(
    (update: SetStateAction<boolean>) =>
      setPersistentReaderBoolean(outlineOpenRef, setOutlineOpenState, readerOutlineOpenSettingKey, update),
    [setPersistentReaderBoolean],
  );
  const setRightPanelOpen = useCallback(
    (update: SetStateAction<boolean>) =>
      setPersistentReaderBoolean(rightPanelOpenRef, setRightPanelOpenState, readerRightPanelOpenSettingKey, update),
    [setPersistentReaderBoolean],
  );
  const setTranslationPanelOpen = useCallback(
    (update: SetStateAction<boolean>) =>
      setPersistentReaderBoolean(
        translationPanelOpenRef,
        setTranslationPanelOpenState,
        readerTranslationPanelOpenSettingKey,
        update,
      ),
    [setPersistentReaderBoolean],
  );

  useEffect(() => {
    const nextOutlineCompact = settingsBoolean(state.settings, readerOutlineCompactSettingKey, false);
    const nextOutlineOpen = settingsBoolean(state.settings, readerOutlineOpenSettingKey, true);
    const nextRightPanelOpen = settingsBoolean(state.settings, readerRightPanelOpenSettingKey, true);
    const nextTranslationPanelOpen = settingsBoolean(state.settings, readerTranslationPanelOpenSettingKey, false);
    outlineCompactRef.current = nextOutlineCompact;
    outlineOpenRef.current = nextOutlineOpen;
    rightPanelOpenRef.current = nextRightPanelOpen;
    translationPanelOpenRef.current = nextTranslationPanelOpen;
    setOutlineCompactState((current) => (current === nextOutlineCompact ? current : nextOutlineCompact));
    setOutlineOpenState((current) => (current === nextOutlineOpen ? current : nextOutlineOpen));
    setRightPanelOpenState((current) => (current === nextRightPanelOpen ? current : nextRightPanelOpen));
    setTranslationPanelOpenState((current) => (current === nextTranslationPanelOpen ? current : nextTranslationPanelOpen));
  }, [
    state.settings.readerOutlineCompact,
    state.settings.readerOutlineOpen,
    state.settings.readerRightPanelOpen,
    state.settings.readerTranslationPanelOpen,
  ]);

  useEffect(() => {
    if (!translationPanelOpen) {
      setSelectedSentenceId(null);
    }
  }, [translationPanelOpen]);

  const upsertAiResultInState = useCallback((result: AiResultRecord, removeIds: string[] = []) => {
    setState((current) => {
      const remove = new Set([result.id, ...removeIds].filter(Boolean));
      const aiResults = [result, ...current.aiResults.filter((item) => !remove.has(item.id))];
      return { ...current, aiResults };
    });
  }, []);

  const updateAiResultInState = useCallback((id: string, updater: (result: AiResultRecord) => AiResultRecord) => {
    setState((current) => {
      let changed = false;
      const aiResults = current.aiResults.map((item) => {
        if (item.id !== id) {
          return item;
        }
        changed = true;
        return updater(item);
      });
      return changed ? { ...current, aiResults } : current;
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
    onLoaded: () => setStartupReady(true),
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
  const activeLastReaderViewport = useMemo(
    () => lastReaderViewportFromSettings(state.settings, activeDocumentId),
    [activeDocumentId, state.settings],
  );
  const activePdfDocument = activeDocumentId && activeDocumentId === loadedDocumentId ? pdfDocument : null;
  const displayZoom = rightPanelOpen && fitPageWithPanel && fittedZoom !== null ? Math.min(zoom, fittedZoom) : zoom;

  useEffect(() => {
    setFitPageWithPanel(true);
  }, [rightPanelOpen, activeDocumentId]);

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
    setFolderExpanded,
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

  function shouldPersistPageTextLayout(
    settings: AppStateRecord["settings"],
    documentId: string,
    pageNumber: number,
    inference: PageTextLayoutInference,
    source: "local" | "ai",
  ) {
    const layoutKey = pageTextLayoutSettingKey(documentId, pageNumber);
    const confidenceKey = pageTextLayoutConfidenceSettingKey(documentId, pageNumber);
    const sourceKey = pageTextLayoutSourceSettingKey(documentId, pageNumber);
    const existingSource = settings[sourceKey] || "";
    const existingConfidence = Number(settings[confidenceKey] || "0");
    const nextConfidence = Math.max(0, Math.min(1, inference.confidence));
    return !(
      settings[layoutKey] === inference.mode &&
      existingSource === source &&
      Number.isFinite(existingConfidence) &&
      existingConfidence >= nextConfidence
    );
  }

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
    if (!shouldPersistPageTextLayout(stateRef.current.settings, documentId, pageNumber, inference, source)) {
      return;
    }
    stateRef.current = {
      ...stateRef.current,
      settings: {
        ...stateRef.current.settings,
        [layoutKey]: inference.mode,
        [confidenceKey]: confidence,
        [sourceKey]: source,
      },
    };
    setState((current) => {
      if (!shouldPersistPageTextLayout(current.settings, documentId, pageNumber, inference, source)) {
        return current;
      }
      return {
        ...current,
        settings: {
          ...current.settings,
          [layoutKey]: inference.mode,
          [confidenceKey]: confidence,
          [sourceKey]: source,
        },
      };
    });
    await Promise.all([
      setSetting(layoutKey, inference.mode),
      setSetting(confidenceKey, confidence),
      setSetting(sourceKey, source),
    ]);
  }

  function rememberPageTextLayout(documentId: string, pageNumber: number, inference: PageTextLayoutInference) {
    if (!shouldPersistPageTextLayout(stateRef.current.settings, documentId, pageNumber, inference, "local")) {
      return;
    }
    void persistPageTextLayoutInference(documentId, pageNumber, inference).catch((error) =>
      showToast(`${ui.aiTaskFailedPrefix}: ${String(error)}`, "error"),
    );
  }

  function clearDocumentPageCaches(documentId: string) {
    const shouldRemove = (key: string) => [
      `pdfTextExtractionVersion:${documentId}`,
      `documentOutlineVersion:${documentId}`,
      `pageTextLayoutAiVersion:${documentId}`,
    ].includes(key) || [
      `pageTextLayout:${documentId}:`,
      `pageTextLayoutConfidence:${documentId}:`,
      `pageTextLayoutSource:${documentId}:`,
    ].some((prefix) => key.startsWith(prefix));
    const settings = { ...stateRef.current.settings };
    for (const key of Object.keys(settings)) if (shouldRemove(key)) delete settings[key];
    stateRef.current = {
      ...stateRef.current,
      settings,
      pages: stateRef.current.pages.filter((page) => page.documentId !== documentId),
    };
    patchState((draft) => {
      draft.pages = draft.pages.filter((page) => page.documentId !== documentId);
      for (const key of Object.keys(draft.settings)) if (shouldRemove(key)) delete draft.settings[key];
    });
  }

  async function loadPdfBytes(document: DocumentRecord, bytes?: Uint8Array) {
    const settings = stateRef.current.settings;
    const autoKey = documentAutoTranslateSettingKey(document.id);
    const wordKey = documentWordMeaningLookupSettingKey(document.id);
    const autoTranslate = settings[autoKey] === "true" ? "true" : "false";
    const wordMeaning = settings[wordKey] === "false" ? "false" : "true";
    const nextSettings = {
      ...settings,
      autoTranslate,
      wordMeaningLookupEnabled: wordMeaning,
      [autoKey]: autoTranslate,
      [wordKey]: wordMeaning,
    };
    stateRef.current = { ...stateRef.current, settings: nextSettings };
    patchState((draft) => {
      draft.settings.autoTranslate = autoTranslate;
      draft.settings.wordMeaningLookupEnabled = wordMeaning;
      draft.settings[autoKey] = autoTranslate;
      draft.settings[wordKey] = wordMeaning;
    });
    const lastViewport = lastReaderViewportFromSettings(nextSettings, document.id);
    const initialPage = lastViewport?.page ?? 1;
    setMode("reader");
    if (!isTauriRuntime() && !bytes && activeDocumentId === document.id && loadedDocumentId === document.id && pdfDocument) {
      setPageCursor(initialPage);
      return;
    }
    setIsBusy(true);
    setActiveDocumentId(document.id);
    setPageCursor(initialPage);
    try {
      try {
        await setSettings([
          ["autoTranslate", autoTranslate],
          ["wordMeaningLookupEnabled", wordMeaning],
          [autoKey, autoTranslate],
          [wordKey, wordMeaning],
        ]);
      } catch (error) {
        showToast(String(error), "error");
      }
      let pdfBytes = bytes;
      if (!pdfBytes) {
        try {
          pdfBytes = await readDocumentBytes(document.id);
        } catch (error) {
          if (!isTauriRuntime()) throw error;
          const failure = String(error);
          let relinked: DocumentRecord | null;
          if (failure.includes("PDF_SOURCE_MISSING:")) {
            showToast(uiLanguage === "ko"
              ? "원본 PDF를 찾을 수 없습니다. 새 위치의 같은 파일을 선택해 주세요."
              : "The original PDF is missing. Select the same file at its new location.");
            relinked = await relinkPdf(document.id);
          } else if (failure.includes("PDF_SOURCE_CHANGED:") && document.sourcePath) {
            const confirmed = window.confirm(uiLanguage === "ko"
              ? "원본 PDF의 내용이 바뀌었습니다. 새 내용으로 열까요? 기존 주석의 위치가 어긋날 수 있습니다."
              : "The original PDF has changed. Open the new version? Existing annotations may no longer align.");
            relinked = confirmed ? (await importPdfPaths([document.sourcePath]))[0] ?? null : null;
            if (relinked) clearDocumentPageCaches(document.id);
          } else {
            throw error;
          }
          if (!relinked) {
            setMode("library");
            setActiveDocumentId(null);
            return;
          }
          document = relinked;
          patchState((draft) => {
            draft.documents = draft.documents.map((item) => item.id === relinked.id ? relinked : item);
          });
          await refreshLibrary();
          pdfBytes = await readDocumentBytes(document.id);
        }
      }
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
      const scholarlyProfile = isTauriRuntime() ? await scholarlyInvoke<DocumentScholarlyProfile | null>("scholarly_profile", { documentId: document.id }).catch(() => null) : null;
      const shouldUpdateTitle = !scholarlyProfile?.confirmedFields.includes("title") && shouldUseAutomaticTitle(document);
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
      const updated = readerAutomaticMetadata(document, info, automaticTitle, pdf.numPages, scholarlyProfile?.confirmedFields);
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
      const extractionVersionKey = pdfTextExtractionVersionKey(document.id);
      if (stateRef.current.settings[extractionVersionKey] !== pdfTextExtractionVersion) {
        const pages = await extractOrderedPagesFromPdf(updated, pdf);
        await replaceExtractedPages(document.id, pages);
        await setSetting(extractionVersionKey, pdfTextExtractionVersion);
        patchState((draft) => { draft.settings[extractionVersionKey] = pdfTextExtractionVersion; });
      }
      setLoadedDocumentId(document.id);
      setPdfDocument(pdf);
    } catch (error) {
      showToast(`${ui.openPdfErrorPrefix}: ${String(error)}`, "error");
    } finally {
      setIsBusy(false);
    }
  }

  finderOpenHandlerRef.current = async (document) => {
    const previous = stateRef.current.documents.find((item) => item.id === document.id);
    if (previous && previous.hash !== document.hash) clearDocumentPageCaches(document.id);
    patchState((draft) => {
      draft.documents = [document, ...draft.documents.filter((item) => item.id !== document.id)];
    });
    await refreshLibrary();
    await loadPdfBytes(document);
  };

  const refreshLibrary = useCallback(async () => {
    if (!isTauriRuntime()) return;
    const library = await loadLibrary();
    patchState((draft) => {
      draft.folders = library.folders;
      draft.documents = draft.documents.map((document) => {
        const current = library.documents.find((item) => item.id === document.id);
        return current ? { ...document, folderId: current.folderId, sourcePath: current.sourcePath, filePath: current.filePath, hash: current.hash } : document;
      });
    });
  }, [patchState]);

  useEffect(() => {
    if (!startupReady || mode !== "library" || !isTauriRuntime()) return;
    let running = false;
    const refresh = () => {
      if (running) return;
      running = true;
      void refreshLibrary().catch((error) => showToast(String(error), "error")).finally(() => { running = false; });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [mode, startupReady, refreshLibrary, showToast]);

  async function acceptDesktopPdfs(documents: DocumentRecord[]) {
    for (const document of documents) {
      const previous = stateRef.current.documents.find((item) => item.id === document.id);
      if (previous && previous.hash !== document.hash) clearDocumentPageCaches(document.id);
    }
    patchState((draft) => {
      const imported = new Map(documents.map((document) => [document.id, document]));
      draft.documents = [...imported.values(), ...draft.documents.filter((document) => !imported.has(document.id))];
    });
    await refreshLibrary();
    for (const document of documents) await loadPdfBytes(document);
  }

  async function pickPdfFiles() {
    if (!isTauriRuntime()) {
      fileInputRef.current?.click();
      return;
    }
    setIsBusy(true);
    try {
      const documents = await pickPdfs();
      if (documents.length) await acceptDesktopPdfs(documents);
    } catch (error) {
      showToast(`${ui.importFailedPrefix}: ${String(error)}`, "error");
    } finally {
      setIsBusy(false);
    }
  }

  const desktopDropHandlerRef = useRef<(paths: string[]) => Promise<void>>(async () => {});
  desktopDropHandlerRef.current = async (paths) => {
    const pdfPaths = paths.filter((path) => /\.pdf$/i.test(path));
    setDragActive(false);
    if (!pdfPaths.length) return;
    setIsBusy(true);
    try {
      await acceptDesktopPdfs(await importPdfPaths(pdfPaths));
    } catch (error) {
      showToast(`${ui.importFailedPrefix}: ${String(error)}`, "error");
    } finally {
      setIsBusy(false);
    }
  };

  useEffect(() => {
    if (!startupReady || !isTauriRuntime()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
        void desktopDropHandlerRef.current(event.payload.paths);
      }))
      .then((stop) => { if (cancelled) stop(); else unlisten = stop; })
      .catch((error) => showToast(String(error), "error"));
    return () => { cancelled = true; unlisten?.(); };
  }, [startupReady, showToast]);

  useEffect(() => {
    if (!startupReady || !isTauriRuntime()) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const drain = async () => {
      if (finderDrainRunningRef.current) {
        finderDrainRequestedRef.current = true;
        return;
      }
      finderDrainRunningRef.current = true;
      try {
        let documents: DocumentRecord[];
        do {
          finderDrainRequestedRef.current = false;
          documents = await takeOpenedPdfs();
          for (const document of documents) {
            if (cancelled) return;
            await finderOpenHandlerRef.current(document);
          }
        } while (!cancelled && (documents.length > 0 || finderDrainRequestedRef.current));
      } catch (error) {
        showToast(String(error), "error");
      } finally {
        finderDrainRunningRef.current = false;
      }
    };
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("paper-pilot:opened-pdf", () => void drain()))
      .then((stop) => {
        if (cancelled) stop();
        else {
          unlisten = stop;
          void drain();
        }
      })
      .catch((error) => showToast(String(error), "error"));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [startupReady, showToast]);

  async function handleFiles(files: FileList | File[]) {
    if (isTauriRuntime()) {
      await pickPdfFiles();
      return;
    }
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
    setState((current) => {
      const nextPages = current.pages.filter((page) => page.documentId !== documentId).concat(pages);
      return { ...current, pages: nextPages };
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
    const isExplanationTask = taskType === "explainText" || taskType === "explainRegionImage";
    const providerKind = taskType === "indexPaperCitations" ? "codex-cli" : normalizeAiProviderKind(state.settings.aiProvider);
    const optimisticChatId =
      taskType === "chatWithPaper" && typeof payload.question === "string" ? makeId("chat-pending") : "";
    if (optimisticChatId) {
      const question = typeof payload.question === "string" ? payload.question.trim() : "";
      upsertAiResultInState({
        id: optimisticChatId,
        documentId: activeDocument.id,
        taskType,
        inputText: question,
        outputText: "",
        status: "pending",
        createdAt: nowIso(),
        provider: providerKind,
        model: selectedAiModelForRun(state.settings),
      });
      setAssistantMode("study");
      if (!options.keepPanel && !isExplanationTask) {
        setActivePanel("ai");
      }
    }
    try {
      const needsPages =
        ["summarizePaper", "chatWithPaper", "autoHighlight", "outlineDocument", "indexPaperCitations", "classifyDocumentLayout", wordMeaningTaskType].includes(taskType) ||
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
        taskPayload.documentContextPack = contextPack;
        taskPayload.askMode = "deep";
      }
      if (taskType === "translatePage" && !taskPayload.text && typeof taskPayload.page === "number") {
        taskPayload.text = pages.find((page) => page.pageNumber === taskPayload.page)?.text ?? "";
      }
      const explicitProviderSessionId =
        typeof taskPayload.providerSessionId === "string" ? taskPayload.providerSessionId : "";
      const providerSessionId =
        explicitProviderSessionId ||
        (taskType === "chatWithPaper"
          ? latestProviderSessionId(
              activeAiResults.filter((result) => result.taskType.toString() === "chatWithPaper"),
              providerKind,
              paperChatExcludedResultIds(state.settings[`paperChatExcludedResults:${activeDocument.id}`]),
            )
          : "");
      const queued = await runAiTask(providerKind, bridgePath, taskType, activeDocument, {
        ...taskPayload,
        customPrompt: taskType === "indexPaperCitations" ? "" : state.settings.customPrompt,
        mathDelimiter: state.settings.mathDelimiter,
        model: selectedAiModelForRun(taskType === "indexPaperCitations" ? { ...state.settings, aiProvider: "codex-cli" } : state.settings),
        reasoningEffort: providerKind === "codex-cli" ? selectedCodexReasoningEffort(state.settings) : "",
        providerSessionId,
      });
      upsertAiResultInState(queued, optimisticChatId ? [optimisticChatId] : []);
      if (!isExplanationTask && taskType !== "indexPaperCitations") {
        setAssistantMode(taskType === "citationReason" || taskType === "externalLinkSummary" ? "quotes" : "study");
      }
      if (isExplanationTask) {
        setFloatingResultId(typeof taskPayload.parentResultId === "string" ? taskPayload.parentResultId : queued.id);
      }
      if (!options.keepPanel && !isExplanationTask) {
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
        updateAiResultInState(optimisticChatId, (item) => ({
          ...item,
          outputText: String(error),
          status: "failed",
        }));
      }
      if (!options.silent) {
        showToast(`${ui.aiTaskFailedPrefix}: ${String(error)}`, "error");
      }
      return null;
    }
  }

  async function queueExplanationFollowUp(rootResult: AiResultRecord, question: string): Promise<void> {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) {
      return;
    }
    const rootId = rootResult.parentResultId || rootResult.id;
    const root = activeAiResults.find((result) => result.id === rootId) ?? rootResult;
    if (!["explainText", "explainRegionImage"].includes(root.taskType.toString())) {
      return;
    }
    const threadResults = activeAiResults
      .filter((result) => result.id === rootId || result.parentResultId === rootId)
      .slice()
      .sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
      });
    const latestSessionResult = threadResults
      .slice()
      .reverse()
      .find((result) => normalizeAiProviderKind(result.provider) === normalizeAiProviderKind(state.settings.aiProvider) && result.providerSessionId);
    const conversationHistory = threadResults.map((result, index) => ({
      label: index === 0 ? "Initial explanation" : `Follow-up ${index}`,
      user: index === 0 ? result.inputText : stripChatAskPrefix(result.inputText),
      assistant: getReadableAiOutput(result, ui),
    }));
    const queued = await queueTask(
      root.taskType as AiTaskType,
      {
        question: trimmedQuestion,
        parentResultId: rootId,
        parentInputText: root.inputText,
        parentOutputText: getReadableAiOutput(root, ui),
        conversationHistory,
        providerSessionId: latestSessionResult?.providerSessionId || root.providerSessionId || "",
        ...(root.taskType.toString() === "explainText" ? { text: root.inputText } : {}),
      },
      { keepPanel: true },
    );
    if (queued) {
      setFloatingResultId(rootId);
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
    await queueTranslationForPage(page, { silent: false, force: true });
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
    lastReaderViewport: activeLastReaderViewport,
    activeOutlineRows,
    patchState,
    commitZoom,
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
    openSentenceActions,
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
    wordLookupError,
    persistWordListForPages,
    saveWordMeaningsFromResult,
    saveDocumentLayoutFromResult,
    deleteWordMeaningEntry,
    queueMissingWordMeanings,
    queueAdjustedWordMeaning,
    openWordMeaningPopup,
    openSelectedMeaningPopup,
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
    ensureActivePages,
  });

  async function startNewPaperChat() {
    if (!activeDocument) return;
    const key = `paperChatExcludedResults:${activeDocument.id}`;
    const value = JSON.stringify(activeAiResults.filter((result) => result.taskType === "chatWithPaper").map((result) => result.id));
    try {
      await setSettings([[key, value]]);
      patchState((draft) => { draft.settings[key] = value; });
      showToast(ui.newChatStarted);
    } catch (error) {
      showToast(String(error));
    }
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
    upsertAiResultInState,
    showToast,
    translationRequestsRef,
    setFloatingResultId,
    saveWordMeaningsFromResult,
    saveDocumentLayoutFromResult,
  });

  function sentencePageFromId(id: string) {
    return Number(id.match(/^p(\d+)-(?:s|ai)\d+$/)?.[1] ?? 0);
  }

  function sourceSentenceIdsForSelection(id: string) {
    const unit = currentTranslationUnits.find(
      (item) => item.id === id || (item.sourceIds ?? []).includes(id),
    );
    return unit?.sourceIds?.length ? unit.sourceIds : [id];
  }

  function scrollPdfSentenceIntoView(ids: string[], attempt = 0) {
    const sentenceIds = ids.filter(Boolean);
    if (sentenceIds.length === 0) {
      return;
    }
    const page = sentenceIds.map(sentencePageFromId).find((value) => value > 0) ?? 0;
    window.setTimeout(() => {
      const targets = Array.from(document.querySelectorAll<HTMLElement>(".text-layer [data-sentence-id]"));
      const target = targets.find((node) => node.dataset.sentenceId && sentenceIds.includes(node.dataset.sentenceId));
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
        return;
      }
      if (attempt < 14) {
        scrollPdfSentenceIntoView(sentenceIds, attempt + 1);
        return;
      }
      const pageShell = page > 0 ? document.getElementById(`page-${page}`) : null;
      pageShell?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
    }, attempt === 0 ? 80 : 120);
  }

  function selectSentenceAndScroll(id: string) {
    setSelectedSentenceId(id);
    const sourceIds = sourceSentenceIdsForSelection(id);
    const page = sourceIds.map(sentencePageFromId).find((value) => value > 0) ?? sentencePageFromId(id);
    if (page > 0 && page !== pageCursor) {
      goToPage(page);
    }
    scrollPdfSentenceIntoView(sourceIds);
  }

  function focusTranslationSentence(id: string) {
    setSelectedSentenceId(id);
    const sourceIds = sourceSentenceIdsForSelection(id);
    const page = sourceIds.map(sentencePageFromId).find((value) => value > 0) ?? sentencePageFromId(id);
    if (page > 0 && page !== pageCursor) {
      setPageCursor(page);
    }
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
    ensureActivePages,
    extractOrderedPagesFromPdf,
    replaceExtractedPages,
    saveDocumentLayoutFromResult,
    runAutoHighlightForCurrentPage,
    patchState,
    agentParallelTaskLimit,
  });

  const paperCitations = usePaperCitations({ state, activeDocument, pdfDocument: activePdfDocument, activePages, queueTask, patchState, ensureActivePages });

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
    floatingResult && floatingResult.taskType.toString() === "translatePage",
  );

  function translateSelectedText() {
    if (!selectionToolbar) return;
    const selectedText = selectionToolbar.text.trim();
    const matchText = normalizeComparable(selectedText).toLowerCase();
    const sentence = sentenceUnitsForPage(activePages.find((page) => page.pageNumber === selectionToolbar.page))
      .find((unit) => normalizeComparable(unit.source).toLowerCase().includes(matchText));
    openSelectedMeaningPopup({
      word: selectedText,
      page: selectionToolbar.page,
      sourceSentenceId: sentence?.id,
      context: sentence?.source ?? selectedText,
      x: selectionToolbar.viewportRect?.left ?? selectionToolbar.x,
      y: selectionToolbar.viewportRect?.top ?? selectionToolbar.y,
      side: "right",
    });
    setSelectionToolbar(null);
    setTextSelectionPreview(null);
    window.getSelection()?.removeAllRanges();
  }

  return (
    <UiStringsContext.Provider value={ui}>
    <ScholarlyProvider state={state} ready={startupReady} ko={uiLanguage === "ko"} openedDocument={mode === "reader" && !isBusy && activePdfDocument ? activeDocument : null}
      notify={showToast} onOpen={(document) => void loadPdfBytes(document)}
      onDocumentChanged={async (document) => {
        patchState((draft) => { draft.documents = [document, ...draft.documents.filter((item) => item.id !== document.id)]; });
        await refreshLibrary();
      }}
      saveSetting={(key, value) => { patchState((draft) => { draft.settings[key] = value; }); void setSetting(key, value); }}
    >
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
        if (!isTauriRuntime()) void handleFiles(event.dataTransfer.files);
      }}
    >
      <main className="workspace">
        <TopToolbar
          ui={ui}
          mode={mode}
          document={activeDocument}
          zoom={displayZoom}
          fitAvailable={rightPanelOpen && Boolean(activePdfDocument)}
          fitToWidth={rightPanelOpen && fitPageWithPanel && fittedZoom !== null && zoom > fittedZoom}
          pageCursor={pageCursor}
          pageCount={activePdfDocument?.numPages ?? activeDocument?.pageCount ?? 0}
          searchTerm={searchTerm}
          busy={isBusy}
          outlineOpen={outlineOpen}
          rightPanelOpen={rightPanelOpen}
          shareReady={Boolean(activeDocument && (activePdfDocument || Object.keys(pageImages).length > 0))}
          onOpenLibrary={openLibraryMode}
          onOpenDiscover={() => setMode("discover")}
          onOpenSettings={toggleSettingsMode}
          onZoomIn={() => { setFitPageWithPanel(false); commitZoomKeepingView(displayZoom + 0.1); }}
          onZoomOut={() => { setFitPageWithPanel(false); commitZoomKeepingView(displayZoom - 0.1); }}
          onPageChange={(page) => goToPage(page)}
          onSearch={setSearchTerm}
          onTogglePanel={() => setRightPanelOpen((value) => !value)}
          onToggleTranslationPanel={() => setTranslationPanelOpen((value) => !value)}
          onZoomChange={(value) => { setFitPageWithPanel(false); commitZoomKeepingView(value); }}
          onFitToWidth={() => setFitPageWithPanel(true)}
          onShowOutline={() => {
            if (mode === "reader") {
              setOutlineOpen((value) => !value);
            } else {
              setMode(activeDocument ? "reader" : mode);
              setOutlineOpen(true);
            }
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
            const documentKey = activeDocument ? documentAutoTranslateSettingKey(activeDocument.id) : null;
            patchState((draft) => {
              draft.settings.autoTranslate = next;
              if (documentKey) draft.settings[documentKey] = next;
            });
            void setSettings(documentKey ? [["autoTranslate", next], [documentKey, next]] : [["autoTranslate", next]]);
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

        {(mode === "discover" || discoverVisited) && <div className="discover-workspace" hidden={mode !== "discover"}><DiscoverView /></div>}

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
            onFolderExpanded={setFolderExpanded}
            onNewFolderName={setNewFolderName}
            onCreateFolder={(parentId, name) => void createFolder(parentId, name)}
            onCreateChildFolder={(parentId) => void createChildFolder(parentId)}
            onRenameFolder={(folder) => void renameFolder(folder)}
            onDeleteFolder={(folder) => void deleteFolderTree(folder)}
            onPickFile={() => void pickPdfFiles()}
            onDiscover={() => setMode("discover")}
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
            paperCitations={paperCitations.references}
            citationIndexStatus={paperCitations.indexStatus}
            onRetryCitationIndex={() => void paperCitations.retryIndex()}
            onCitationClick={(referenceId, label, x, y) => {
              setWordPopup(null);
              setLinkPreview(null);
              paperCitations.openCitation(referenceId, label, x, y);
            }}
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
            zoom={displayZoom}
            onFitZoomChange={setFittedZoom}
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
            onPickFile={() => void pickPdfFiles()}
            onLoadActiveDocument={(document) => void loadPdfBytes(document)}
            onShowToast={showToast}
            onPatchState={patchState}
            onStartLayoutResize={startLayoutResize}
            onGoToPage={goToPage}
            onGoToOutlineRow={goToOutlineRow}
            onAddReaderBookmark={addReaderBookmark}
            onOpenSelectedSentenceActions={() => {
              const sourceId = selectedSentenceId ? sourceSentenceIdsForSelection(selectedSentenceId)[0] : null;
              if (sourceId) {
                openSentenceActions(sentencePageFromId(sourceId) || pageCursor, sourceId);
              }
            }}
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
            onOpenExplanationResult={(result) => {
              setFloatingAvoidRect(null);
              setFloatingResultId(result.parentResultId || result.id);
            }}
            onDeleteAnnotationById={(id) => void deleteAnnotationById(id)}
            onOpenLinkPreview={(target) => void openLinkPreview(target)}
            onOpenWordMeaningPopup={openWordMeaningPopup}
            onFocusTranslationSentence={focusTranslationSentence}
            onNewChat={startNewPaperChat}
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
            onPickObsidianVault={async () => {
              const vault = await obsidianPickVault();
              if (!vault) return false;
              const configured = await obsidianConfigure(vault, state.settings.obsidianFolder || "Paper Pilot", state.settings.obsidianEnabled === "true");
              patchState((draft) => {
                draft.settings.obsidianVaultPath = configured.vaultPath;
                draft.settings.obsidianFolder = configured.folder;
                draft.settings.obsidianEnabled = String(configured.enabled);
              });
              return true;
            }}
            onConfigureObsidian={async (vaultPath, folder, enabled) => {
              const configured = await obsidianConfigure(vaultPath, folder, enabled);
              patchState((draft) => {
                draft.settings.obsidianVaultPath = configured.vaultPath;
                draft.settings.obsidianFolder = configured.folder;
                draft.settings.obsidianEnabled = String(configured.enabled);
              });
            }}
            onSyncObsidian={obsidianSyncNow}
            onResetWorkspace={() => void resetWorkspace()}
            onChange={(key, value) => {
              const documentKey = key === "autoTranslate" && activeDocument
                ? documentAutoTranslateSettingKey(activeDocument.id)
                : null;
              patchState((draft) => {
                draft.settings[key] = value;
                if (documentKey) draft.settings[documentKey] = value;
              });
              void setSettings(documentKey ? [[key, value], [documentKey, value]] : [[key, value]]);
            }}
          />
        )}
      </main>

      {selectionToolbar && activeDocument && (
        <SelectionToolbarView
          toolbar={selectionToolbar}
          onExplain={() => void explainSelection()}
          onTranslate={translateSelectedText}
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
          results={activeAiResults}
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
          onFollowUp={(result, question) => queueExplanationFollowUp(result, question)}
        />
      )}

      {wordPopup && (
        <WordMeaningPopup
          ui={ui}
          popup={wordPopup}
          entries={displayWordMeaningEntries(wordMeaningMap[normalizeWordKey(wordPopup.word)] ?? [])}
          clickCount={wordClickCountsFromSettings(state.settings)[normalizeWordKey(wordPopup.word)] ?? 0}
          loading={wordLookupLoadingKey === normalizeWordKey(wordPopup.word)}
          error={wordLookupError}
          onClose={() => setWordPopup(null)}
          onAdjust={() => void queueAdjustedWordMeaning(wordPopup)}
          onOpenSentenceActions={() => {
            if (wordPopup.sourceSentenceId) {
              openSentenceActions(wordPopup.page, wordPopup.sourceSentenceId);
              setWordPopup(null);
            }
          }}
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
      {paperCitations.popup && paperCitations.references.find((reference) => reference.id === paperCitations.popup?.referenceId) && <CitationPopover
        key={`${paperCitations.popup.documentId}:${paperCitations.popup.referenceId}`}
        popup={paperCitations.popup}
        reference={paperCitations.references.find((reference) => reference.id === paperCitations.popup?.referenceId)!}
        onClose={() => paperCitations.setPopup(null)}
        onRetry={() => paperCitations.retryReference(paperCitations.popup!.referenceId)}
      />}

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
    </ScholarlyProvider>
    </UiStringsContext.Provider>
  );
}

export default App;
