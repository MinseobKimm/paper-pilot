import { useEffect, useRef, useState } from "react";
import type { AiResultRecord, AiTaskType, AppStateRecord, DocumentRecord, PageRecord } from "../types";
import type { PdfDocumentProxy } from "../lib/pdfDocument";
import { citationIndexFromSettings, citationIndexKey, citationIndexVersion, hasBlockingCitationIndexTask, parsePaperCitationIndex, rankCitationPapers, type PaperCitationIndex } from "../lib/paperCitations";
import { setSetting, isTauriRuntime } from "../lib/tauri";
import { scholarlyInvoke, scholarlyRequestId } from "../lib/scholarlyService";
import type { PaperPage } from "../types/scholarly";

type Input = {
  state: AppStateRecord; activeDocument: DocumentRecord | null; pdfDocument: PdfDocumentProxy | null; activePages: PageRecord[];
  queueTask: (type: AiTaskType, payload: Record<string, unknown>, options?: { silent?: boolean; keepPanel?: boolean }) => Promise<AiResultRecord | null>;
  ensureActivePages: () => Promise<PageRecord[]>;
  patchState: (mutator: (draft: AppStateRecord) => void) => void;
};
export type CitationPopup = { documentId: string; referenceId: string; label: string; x: number; y: number };

export function usePaperCitations(input: Input) {
  const latest = useRef(input); latest.current = input;
  const indexes = useRef(new Map<string, PaperCitationIndex>());
  const queued = useRef(new Set<string>());
  const processed = useRef(new Set<string>());
  const background = useRef(new Set<string>());
  const requests = useRef(new Map<string, Promise<void>>());
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [popup, setPopup] = useState<CitationPopup | null>(null);
  const documentId = input.activeDocument?.id ?? "";
  const stored = citationIndexFromSettings(input.state.settings, documentId);
  const results = input.state.aiResults.filter((result) => result.documentId === documentId && result.taskType === "indexPaperCitations")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  function indexFor(id: string) {
    return indexes.current.get(id) ?? citationIndexFromSettings(latest.current.state.settings, id);
  }
  async function persist(id: string, index: PaperCitationIndex) {
    if (!latest.current.state.documents.some((document) => document.id === id)) return;
    indexes.current.set(id, index);
    const key = citationIndexKey(id); const value = JSON.stringify(index);
    latest.current.patchState((draft) => { draft.settings[key] = value; });
    const save = saveChain.current.catch(() => undefined).then(() => setSetting(key, value));
    saveChain.current = save;
    await save;
  }
  async function queueIndex(force = false) {
    const current = latest.current;
    const document = current.activeDocument;
    if (!document || !current.pdfDocument) return;
    if (!force && (indexFor(document.id) || queued.current.has(document.id) || hasBlockingCitationIndexTask(current.state.aiResults, document.id))) return;
    queued.current.add(document.id);
    setErrors((previous) => ({ ...previous, [document.id]: "" }));
    try {
      const pages = current.activePages.length >= current.pdfDocument.numPages ? current.activePages : await current.ensureActivePages();
      if (latest.current.activeDocument?.id !== document.id) { queued.current.delete(document.id); return; }
      const result = await current.queueTask("indexPaperCitations", { citationIndexVersion, pages }, { silent: true, keepPanel: true });
      if (!result) throw new Error("인용 정보 준비를 시작하지 못했습니다.");
    } catch (error) { setErrors((previous) => ({ ...previous, [document.id]: String(error) })); }
    finally { queued.current.delete(document.id); }
  }

  useEffect(() => { void queueIndex(); }, [documentId, input.pdfDocument, input.activePages.length, stored?.resultId, results[0]?.status]);

  useEffect(() => {
    const latestResults = new Map<string, AiResultRecord>();
    for (const result of input.state.aiResults.filter((item) => item.taskType === "indexPaperCitations").sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      if (!latestResults.has(result.documentId)) latestResults.set(result.documentId, result);
    }
    for (const result of latestResults.values()) {
      if (result.status !== "complete" || processed.current.has(result.id) || indexFor(result.documentId)?.resultId === result.id) continue;
      const pages = input.state.pages.filter((page) => page.documentId === result.documentId);
      const document = input.state.documents.find((item) => item.id === result.documentId);
      // Reopened PDFs can load their saved AI result before their page text.
      if (!document || !pages.length || pages.length < document.pageCount) continue;
      processed.current.add(result.id);
      try {
        const references = parsePaperCitationIndex(result.outputText, pages);
        void persist(result.documentId, { version: citationIndexVersion, resultId: result.id, references }).catch((error) =>
          setErrors((previous) => ({ ...previous, [result.documentId]: String(error) })));
      } catch (error) { setErrors((previous) => ({ ...previous, [result.documentId]: String(error) })); }
    }
  }, [input.state.aiResults, input.state.pages, input.state.documents]);

  function resolveReference(id: string, referenceId: string, refresh = false): Promise<void> {
    const key = `${id}:${referenceId}`;
    const inFlight = requests.current.get(key);
    if (inFlight) return inFlight;
    const index = indexFor(id); const reference = index?.references.find((item) => item.id === referenceId);
    if (!index || !reference || (!refresh && reference.status !== "pending")) return Promise.resolve();
    const job = (async () => {
      try {
        const result = await scholarlyInvoke<PaperPage>("scholarly_search", { request: {
          query: reference.arxivId || `ti:${reference.title}`, category: "", from: "", at: new Date().toISOString(),
          sort: "relevance", page: 1, requestId: scholarlyRequestId(), refresh,
        } });
        const papers = reference.arxivId ? result.papers : rankCitationPapers(reference.title, result.papers);
        const current = indexFor(id);
        if (current?.resultId !== index.resultId) return;
        await persist(id, { ...current, references: current.references.map((item) => item.id === referenceId ? { ...item, papers, status: papers.length ? "found" : "not-found", error: "" } : item) });
      } catch (error) {
        const current = indexFor(id);
        if (current?.resultId === index.resultId) await persist(id, { ...current, references: current.references.map((item) => item.id === referenceId ? { ...item, status: "error", error: String(error) } : item) });
      }
    })().catch((error) => { setErrors((previous) => ({ ...previous, [id]: String(error) })); }).finally(() => { requests.current.delete(key); });
    requests.current.set(key, job);
    return job;
  }

  useEffect(() => {
    if (!stored || !isTauriRuntime() || background.current.has(documentId)) return;
    background.current.add(documentId);
    void (async () => {
      try {
        for (const reference of stored.references) {
          if (latest.current.activeDocument?.id !== documentId) break;
          if (indexFor(documentId)?.references.find((item) => item.id === reference.id)?.status !== "pending") continue;
          await resolveReference(documentId, reference.id);
          const error = indexFor(documentId)?.references.find((item) => item.id === reference.id)?.error;
          if (error?.includes("RATE_LIMIT") || error?.includes("AUTH_OR_LIMIT")) break;
        }
      } finally { background.current.delete(documentId); }
    })();
  }, [documentId, input.state.settings[citationIndexKey(documentId)]]);

  useEffect(() => { setPopup(null); }, [documentId, stored?.resultId]);
  function openCitation(referenceId: string, label: string, x: number, y: number) {
    setPopup({ documentId, referenceId, label, x, y });
    void resolveReference(documentId, referenceId);
  }
  const failed = errors[documentId] || (results[0]?.status === "failed" ? "인용 정보를 준비하지 못했습니다." : "");
  return {
    references: stored?.references ?? [], popup, setPopup, openCitation,
    retryReference: (referenceId: string) => resolveReference(documentId, referenceId, true),
    retryIndex: () => queueIndex(true),
    indexStatus: failed ? "failed" : stored ? "ready" : "preparing",
    indexError: failed,
  };
}
