import type {
  AiResultRecord,
  AgentProviderStatus,
  AnnotationRecord,
  AppStateRecord,
  BridgeResult,
  BridgeTask,
  BridgeWorkerRun,
  CitationCardRecord,
  CommentRecord,
  DocumentRecord,
  ExportBundle,
  FolderRecord,
  NoteRecord,
  PageRecord,
  RecommendationRunRecord,
  ResetWorkspaceResult,
} from "../types";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type TauriWindow = Window &
  typeof globalThis & {
    __TAURI_INTERNALS__?: {
      invoke?: Invoke;
    };
  };

const browserKey = "paperdock-browser-state";

function normalizeAiProviderSetting(value: string | undefined): string {
  if (value === "claude-code") {
    return "claude-code";
  }
  if (value === "local-draft" || value === "api-provider") {
    return "local-draft";
  }
  return "codex-cli";
}

function normalizeState(state: AppStateRecord): AppStateRecord {
  return {
    ...state,
    settings: {
      ...state.settings,
      language: state.settings.uiLanguage === "en" ? "en" : "ko",
      uiLanguage: state.settings.uiLanguage === "en" ? "en" : "ko",
      translationLanguage: state.settings.translationLanguage || "ko",
      aiProvider: normalizeAiProviderSetting(state.settings.aiProvider),
      codexModel: state.settings.codexModel || "",
      codexReasoningEffort: state.settings.codexReasoningEffort || "",
      claudeModel: state.settings.claudeModel || "",
      wordMeaningLookupEnabled: state.settings.wordMeaningLookupEnabled === "false" ? "false" : "true",
    },
    aiResults: state.aiResults.map((result) => ({
      ...result,
      provider: result.provider ? normalizeAiProviderSetting(result.provider) : result.provider,
    })),
  };
}

const emptyState: AppStateRecord = {
  folders: [{ id: "root", parentId: null, name: "Library", createdAt: new Date().toISOString() }],
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
  },
};

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function getInvoke(): Promise<Invoke | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  const invoke = (window as TauriWindow).__TAURI_INTERNALS__?.invoke;
  if (!invoke) {
    throw new Error("Tauri invoke bridge is not available. Restart the desktop app if the dev server was restarted.");
  }
  return invoke;
}

function loadBrowserState(): AppStateRecord {
  const raw = localStorage.getItem(browserKey);
  if (!raw) {
    return structuredClone(emptyState);
  }
  try {
    return normalizeState({ ...structuredClone(emptyState), ...JSON.parse(raw) } as AppStateRecord);
  } catch {
    return structuredClone(emptyState);
  }
}

function saveBrowserState(state: AppStateRecord) {
  localStorage.setItem(browserKey, JSON.stringify(state));
}

export async function loadAppState(): Promise<AppStateRecord> {
  const invoke = await getInvoke();
  if (invoke) {
    return normalizeState(await invoke<AppStateRecord>("load_app_state"));
  }
  return normalizeState(loadBrowserState());
}

export async function getAgentProviderStatus(provider: string): Promise<AgentProviderStatus> {
  const normalized = normalizeAiProviderSetting(provider);
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<AgentProviderStatus>("get_agent_provider_status", { provider: normalized });
  }
  if (normalized === "local-draft") {
    return {
      provider: normalized,
      installed: true,
      message: "Local draft does not require a CLI.",
    };
  }
  return {
    provider: normalized,
    installed: null,
    message: "브라우저 프리뷰에서는 CLI 설치 상태를 확인할 수 없습니다. 데스크톱 앱에서는 실제 CLI 경로를 확인합니다.",
  };
}

export async function importPdf(name: string, bytes: Uint8Array): Promise<DocumentRecord> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<DocumentRecord>("import_pdf", { name, bytes: Array.from(bytes) });
  }
  const state = loadBrowserState();
  const id = crypto.randomUUID();
  const document: DocumentRecord = {
    id,
    title: name.replace(/\.pdf$/i, ""),
    fileName: name,
    filePath: `browser://${id}`,
    hash: `${bytes.byteLength}-${name}`,
    pageCount: 0,
    authors: "",
    year: "",
    abstractText: "",
    folderId: "root",
    bookmarked: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.documents.unshift(document);
  saveBrowserState(state);
  sessionStorage.setItem(`paperdock-pdf-${id}`, JSON.stringify(Array.from(bytes)));
  return document;
}

export async function readDocumentBytes(documentId: string): Promise<Uint8Array> {
  const invoke = await getInvoke();
  if (invoke) {
    return Uint8Array.from(await invoke<number[]>("read_document_bytes", { documentId }));
  }
  const raw = sessionStorage.getItem(`paperdock-pdf-${documentId}`);
  return Uint8Array.from(raw ? JSON.parse(raw) : []);
}

export async function updateDocument(document: DocumentRecord): Promise<DocumentRecord> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<DocumentRecord>("update_document", { document });
  }
  const state = loadBrowserState();
  state.documents = state.documents.map((item) => (item.id === document.id ? document : item));
  saveBrowserState(state);
  return document;
}

export async function deleteDocument(documentId: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("delete_document", { documentId });
    return;
  }
  const state = loadBrowserState();
  state.documents = state.documents.filter((item) => item.id !== documentId);
  state.pages = state.pages.filter((item) => item.documentId !== documentId);
  state.annotations = state.annotations.filter((item) => item.documentId !== documentId);
  state.comments = state.comments.filter((item) => item.documentId !== documentId);
  state.notes = state.notes.filter((item) => item.documentId !== documentId);
  state.aiResults = state.aiResults.filter((item) => item.documentId !== documentId);
  state.citationCards = state.citationCards.filter((item) => item.documentId !== documentId);
  saveBrowserState(state);
  sessionStorage.removeItem(`paperdock-pdf-${documentId}`);
}

export async function savePages(documentId: string, pages: PageRecord[]): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("save_pages", { documentId, pages });
    return;
  }
  const state = loadBrowserState();
  state.pages = state.pages.filter((page) => page.documentId !== documentId).concat(pages);
  const doc = state.documents.find((item) => item.id === documentId);
  if (doc) {
    doc.pageCount = pages.length;
    doc.updatedAt = new Date().toISOString();
  }
  saveBrowserState(state);
}

export async function upsertFolder(folder: FolderRecord): Promise<FolderRecord> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<FolderRecord>("upsert_folder", { folder });
  }
  const state = loadBrowserState();
  state.folders = state.folders.filter((item) => item.id !== folder.id).concat(folder);
  saveBrowserState(state);
  return folder;
}

export async function deleteFolders(ids: string[], reassignFolderId: string): Promise<void> {
  const folderIds = ids.filter((id) => id !== "root");
  if (folderIds.length === 0) {
    return;
  }
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("delete_folders", { ids: folderIds, reassignFolderId });
    return;
  }
  const idSet = new Set(folderIds);
  const state = loadBrowserState();
  const now = new Date().toISOString();
  state.documents = state.documents.map((document) =>
    idSet.has(document.folderId ?? "root")
      ? { ...document, folderId: reassignFolderId, updatedAt: now }
      : document,
  );
  state.folders = state.folders.filter((folder) => !idSet.has(folder.id));
  saveBrowserState(state);
}

export async function upsertAnnotation(annotation: AnnotationRecord): Promise<AnnotationRecord> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<AnnotationRecord>("upsert_annotation", { annotation });
  }
  const state = loadBrowserState();
  state.annotations = state.annotations.filter((item) => item.id !== annotation.id).concat(annotation);
  saveBrowserState(state);
  return annotation;
}

export async function upsertComment(comment: CommentRecord): Promise<CommentRecord> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<CommentRecord>("upsert_comment", { comment });
  }
  const state = loadBrowserState();
  state.comments = state.comments.filter((item) => item.id !== comment.id).concat(comment);
  saveBrowserState(state);
  return comment;
}

export async function deleteAnnotation(id: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("delete_annotation", { id });
    return;
  }
  const state = loadBrowserState();
  state.annotations = state.annotations.filter((item) => item.id !== id);
  saveBrowserState(state);
}

export async function upsertNote(note: NoteRecord): Promise<NoteRecord> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<NoteRecord>("upsert_note", { note });
  }
  const state = loadBrowserState();
  state.notes = state.notes.filter((item) => item.id !== note.id).concat(note);
  saveBrowserState(state);
  return note;
}

export async function deleteNote(id: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("delete_note", { id });
    return;
  }
  const state = loadBrowserState();
  state.notes = state.notes.filter((item) => item.id !== id);
  saveBrowserState(state);
}

export async function upsertCitationCard(citation: CitationCardRecord): Promise<CitationCardRecord> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<CitationCardRecord>("upsert_citation_card", { citation });
  }
  const state = loadBrowserState();
  state.citationCards = state.citationCards.filter((item) => item.id !== citation.id).concat(citation);
  saveBrowserState(state);
  return citation;
}

export async function deleteCitationCard(id: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("delete_citation_card", { id });
    return;
  }
  const state = loadBrowserState();
  state.citationCards = state.citationCards.filter((item) => item.id !== id);
  saveBrowserState(state);
}

export async function saveAiResult(result: AiResultRecord): Promise<AiResultRecord> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<AiResultRecord>("save_ai_result", { result });
  }
  const state = loadBrowserState();
  state.aiResults = state.aiResults.filter((item) => item.id !== result.id).concat(result);
  saveBrowserState(state);
  return result;
}

export async function savePdfFile(suggestedFileName: string, bytes: Uint8Array): Promise<string | null> {
  const invoke = await getInvoke();
  if (!invoke) {
    return null;
  }
  return invoke<string | null>("save_pdf_file", { suggestedFileName, bytes: Array.from(bytes) });
}

export async function deleteAiResults(ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("delete_ai_results", { ids });
    return;
  }
  const idSet = new Set(ids);
  const state = loadBrowserState();
  state.aiResults = state.aiResults.filter((item) => !idSet.has(item.id));
  saveBrowserState(state);
}

export async function saveRecommendationRun(run: RecommendationRunRecord): Promise<RecommendationRunRecord> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<RecommendationRunRecord>("save_recommendation_run", { run });
  }
  const state = loadBrowserState();
  state.recommendationRuns = state.recommendationRuns.filter((item) => item.id !== run.id).concat(run);
  saveBrowserState(state);
  return run;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const invoke = await getInvoke();
  if (invoke) {
    await invoke("set_setting", { key, value });
  }
  const state = loadBrowserState();
  state.settings[key] = value;
  saveBrowserState(state);
}

export async function resetWorkspaceFiles(bridgeDir: string): Promise<ResetWorkspaceResult> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<ResetWorkspaceResult>("reset_workspace_files", { bridgeDir });
  }
  const state = structuredClone(emptyState);
  saveBrowserState(state);
  Object.keys(sessionStorage)
    .filter((key) => key.startsWith("paperdock-pdf-"))
    .forEach((key) => sessionStorage.removeItem(key));
  Object.keys(localStorage)
    .filter((key) => key.startsWith("paperdock-bridge-"))
    .forEach((key) => localStorage.removeItem(key));
  return { state, deletedPaths: ["browser preview storage"], skippedPaths: [] };
}

export async function writeBridgeTask(
  bridgeDir: string,
  taskType: string,
  documentId: string,
  provider: string,
  model: string | undefined,
  reasoningEffort: string | undefined,
  providerSessionId: string | undefined,
  payload: Record<string, unknown>,
): Promise<BridgeTask> {
  const invoke = await getInvoke();
  const payloadJson = JSON.stringify(payload);
  if (invoke) {
    return invoke<BridgeTask>("write_bridge_task", {
      bridgeDir,
      taskType,
      documentId,
      provider,
      model,
      reasoningEffort,
      providerSessionId,
      payloadJson,
    });
  }
  const task: BridgeTask = {
    id: crypto.randomUUID(),
    taskType,
    documentId,
    provider,
    model,
    reasoningEffort,
    providerSessionId,
    payload,
    createdAt: new Date().toISOString(),
    bridgeDir,
    filePath: `${bridgeDir}/outbox/browser-preview.json`,
  };
  localStorage.setItem(`paperdock-bridge-outbox-${task.id}`, JSON.stringify(task));
  return task;
}

export async function readBridgeResult(bridgeDir: string, taskId: string): Promise<BridgeResult | null> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<BridgeResult | null>("read_bridge_result", { bridgeDir, taskId });
  }
  void bridgeDir;
  const raw = localStorage.getItem(`paperdock-bridge-inbox-${taskId}`);
  return raw ? (JSON.parse(raw) as BridgeResult) : null;
}

export async function startBridgeWorker(bridgeDir: string, taskId: string): Promise<BridgeWorkerRun> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<BridgeWorkerRun>("start_bridge_worker", { bridgeDir, taskId });
  }
  return {
    started: false,
    taskId,
    pid: null,
    command: "",
    logPath: "",
    errorLogPath: "",
    finalLogPath: "",
    message: "Agent worker is available only in the desktop app.",
  };
}

export async function exportDocumentJson(documentId: string): Promise<ExportBundle> {
  const invoke = await getInvoke();
  if (invoke) {
    return invoke<ExportBundle>("export_document_json", { documentId });
  }
  const state = loadBrowserState();
  const document = state.documents.find((item) => item.id === documentId);
  if (!document) {
    throw new Error("Document not found");
  }
  return {
    document,
    pages: state.pages.filter((item) => item.documentId === documentId),
    annotations: state.annotations.filter((item) => item.documentId === documentId),
    comments: state.comments.filter((item) => item.documentId === documentId),
    notes: state.notes.filter((item) => item.documentId === documentId),
    aiResults: state.aiResults.filter((item) => item.documentId === documentId),
    citationCards: state.citationCards.filter((item) => item.documentId === documentId),
    exportedAt: new Date().toISOString(),
  };
}

export async function exportDocumentZip(documentId: string): Promise<string> {
  const invoke = await getInvoke();
  if (!invoke) {
    throw new Error("Zip export is available in the desktop app");
  }
  return invoke<string>("export_document_zip", { documentId });
}
