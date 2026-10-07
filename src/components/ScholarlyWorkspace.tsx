import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import type { AppStateRecord, DocumentRecord } from "../types";
import type { CandidatePage, DocumentScholarlyProfile, LibraryLinkScan, LinkedIdentity, PaperMatchCandidate, ScholarlyPaper } from "../types/scholarly";
import { cancelScholarly, emptyMetadataFields, localPaperSeed, ownedPaper, scholarlyInvoke, scholarlyRequestId } from "../lib/scholarlyService";
import { isTauriRuntime } from "../lib/tauri";
import { openExternalUrl } from "../lib/scholarly";

type LinkDialog = { document: DocumentRecord; candidates: PaperMatchCandidate[]; query: string; loading: boolean; error: string; notice: string; localVersion: number | null; selected: number; fields: string[]; requestId: string };
type ScholarlyContextValue = {
  state: AppStateRecord; ko: boolean; identities: LinkedIdentity[]; revision: number;
  scan: LibraryLinkScan | null; scanAction: (action: string) => Promise<void>;
  openLink: (document: DocumentRecord, candidates?: PaperMatchCandidate[]) => void;
  importPaper: (paper: ScholarlyPaper, options?: { openAfterImport?: boolean }) => Promise<void>; onOpen: (document: DocumentRecord) => void;
  onDocumentChanged: (document: DocumentRecord) => Promise<void>;
  notify: (message: string, kind?: "info" | "error") => void;
  saveSetting: (key: string, value: string) => void;
  updateIdentities: () => Promise<void>;
};
const ScholarlyContext = createContext<ScholarlyContextValue | null>(null);
export function useScholarly() { const value = useContext(ScholarlyContext); if (!value) throw new Error("Scholarly workspace missing"); return value; }
export function ScholarlyProvider(props: {
  children: ReactNode; state: AppStateRecord; ready: boolean; ko: boolean;
  openedDocument: DocumentRecord | null;
  onDocumentChanged: (document: DocumentRecord) => Promise<void>;
  onOpen: (document: DocumentRecord) => void; notify: ScholarlyContextValue["notify"];
  saveSetting: ScholarlyContextValue["saveSetting"];
}) {
  const [identities, setIdentities] = useState<LinkedIdentity[]>([]);
  const [revision, setRevision] = useState(0);
  const [dialog, setDialog] = useState<LinkDialog | null>(null);
  const [scan, setScan] = useState<LibraryLinkScan | null>(null);
  const [download, setDownload] = useState<{ id: string; title: string; downloaded: number; total: number | null; error: string; paper: ScholarlyPaper } | null>(null);
  const scanRunning = useRef(false);
  const scanStop = useRef(true);
  const scanRequest = useRef("");
  const stateRef = useRef(props.state); stateRef.current = props.state;
  const dialogRef = useRef(dialog); dialogRef.current = dialog;
  const downloadRef = useRef(download); downloadRef.current = download;
  const mounted = useRef(true);
  const ko = props.ko;
  async function updateIdentities() { if (!isTauriRuntime()) return; setIdentities(await scholarlyInvoke<LinkedIdentity[]>("scholarly_identities")); setRevision((n) => n + 1); }
  useEffect(() => {
    if (!props.ready || !isTauriRuntime()) return;
    void updateIdentities().catch((e) => props.notify(String(e), "error"));
    void scholarlyInvoke<LibraryLinkScan | null>("scholarly_scan_latest").then(setScan).catch((e) => props.notify(String(e), "error"));
  }, [props.ready, props.state.documents.length]);
  useEffect(() => {
    const document = props.openedDocument;
    if (!props.ready || !document || !isTauriRuntime()) return;
    const requestId = scholarlyRequestId();
    let disposed = false;
    void scholarlyInvoke<DocumentRecord | null>("scholarly_auto_link_filename", { documentId: document.id, requestId }).then(async (updated) => {
      if (!mounted.current || !updated || !stateRef.current.documents.some((item) => item.id === updated.id && item.hash === updated.hash)) return;
      await props.onDocumentChanged(updated);
      await updateIdentities();
    }).catch((error) => {
      if (!disposed && !String(error).includes("CANCELLED")) props.notify(`${ko ? "arXiv ID 자동 연결" : "Automatic arXiv link"}: ${String(error)}`, "error");
    });
    return () => { disposed = true; void cancelScholarly(requestId).catch(() => undefined); };
  }, [props.ready, props.openedDocument?.id, props.openedDocument?.hash, props.openedDocument?.fileName]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; scanStop.current = true; if (scanRequest.current) void cancelScholarly(scanRequest.current); if (downloadRef.current) void cancelScholarly(downloadRef.current.id); if (dialogRef.current) void cancelScholarly(dialogRef.current.requestId); };
  }, []);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let disposed = false; let cleanup: (() => void) | undefined;
    void listen<{ requestId: string; downloaded: number; total: number | null }>("paper-pilot:scholarly-download", ({ payload }) => {
      setDownload((current) => current?.id === payload.requestId ? { ...current, downloaded: payload.downloaded, total: payload.total } : current);
    }).then((unlisten) => { if (disposed) unlisten(); else cleanup = unlisten; });
    return () => { disposed = true; cleanup?.(); };
  }, []);
  async function searchCandidates(document: DocumentRecord, query: string, requestId: string) {
    try {
      const text = await localPaperSeed(document, stateRef.current).catch((error) => { if (query.trim()) return ""; throw error; });
      if (dialogRef.current?.requestId !== requestId) return;
      const result = await scholarlyInvoke<CandidatePage>("scholarly_candidates", { documentId: document.id, query, text, requestId });
      setDialog((current) => current?.requestId === requestId ? { ...current, candidates: result.candidates, notice: result.notice, localVersion: result.localVersion, loading: false, fields: [], selected: -1 } : current);
    } catch (e) { setDialog((current) => current?.requestId === requestId ? { ...current, loading: false, error: String(e) } : current); }
  }
  function openLink(document: DocumentRecord, candidates?: PaperMatchCandidate[]) {
    const requestId = scholarlyRequestId();
    const next: LinkDialog = { document, candidates: candidates ?? [], query: "", loading: !candidates, error: "", notice: "", localVersion: null, selected: -1, fields: [], requestId };
    dialogRef.current = next; setDialog(next);
    if (!candidates) void searchCandidates(document, "", requestId);
  }
  async function applyLink() {
    if (!dialog || dialog.selected < 0) return;
    const selection = dialog; setDialog((current) => current ? { ...current, loading: true, error: "" } : null);
    try {
      // Recover the actual local PDF version even when candidates came from a saved scan.
      const seed = await localPaperSeed(selection.document, stateRef.current).catch(() => "");
      const idEvidence = seed.match(/(?:arxiv:\s*|arxiv\.org\/(?:abs|pdf)\/)((?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*\/\d{7}))(?:v(\d+))?/i);
      const paper = selection.candidates[selection.selected].paper;
      const localVersion = idEvidence?.[1]?.toLowerCase() === paper.arxivId && idEvidence[2] ? Number(idEvidence[2]) : null;
      const document = await scholarlyInvoke<DocumentRecord>("scholarly_link", { documentId: selection.document.id, paper, fields: selection.fields, localVersion });
      await props.onDocumentChanged(document);
      await scholarlyInvoke<DocumentScholarlyProfile>("scholarly_refresh", { documentId: document.id, requestId: scholarlyRequestId() }).catch((e) => props.notify(String(e), "error"));
      await updateIdentities(); setDialog(null);
      props.notify(ko ? "온라인 논문 정보를 연결했습니다." : "Paper linked.");
    } catch (e) { setDialog((current) => current ? { ...current, loading: false, error: String(e) } : current); }
  }
  async function importPaper(paper: ScholarlyPaper, options: { openAfterImport?: boolean } = {}) {
    if (downloadRef.current && !downloadRef.current.error) return;
    const existing = ownedPaper(paper, identities);
    const doc = existing && stateRef.current.documents.find((d) => d.id === existing.documentId);
    if (doc) { if (options.openAfterImport !== false) props.onOpen(doc); return; }
    const id = scholarlyRequestId();
    const next = { id, paper, title: paper.title, downloaded: 0, total: null, error: "" }; downloadRef.current = next; setDownload(next);
    try {
      const result = await scholarlyInvoke<{ document: DocumentRecord | null; existing: boolean; cancelled: boolean }>("scholarly_import", { paper, requestId: id });
      if (result.document) { await props.onDocumentChanged(result.document); await updateIdentities(); if (options.openAfterImport !== false) props.onOpen(result.document); props.notify(result.existing ? (ko ? "이미 라이브러리에 있는 논문입니다." : "Paper is already in library.") : (ko ? "PDF를 저장하고 라이브러리에 추가했습니다." : "PDF added to library.")); }
      setDownload(null); downloadRef.current = null;
    } catch (e) {
      if (String(e).includes("CANCELLED")) { setDownload(null); downloadRef.current = null; }
      else setDownload((current) => current?.id === id ? { ...current, error: String(e) } : current);
    }
  }
  async function runScan(job: LibraryLinkScan) {
    if (scanRunning.current) return;
    scanRunning.current = true; scanStop.current = false;
    try {
      while (!scanStop.current && mounted.current) {
        const documentId = await scholarlyInvoke<string | null>("scholarly_scan_next", { scanId: job.id });
        if (!documentId) { setScan(await scholarlyInvoke<LibraryLinkScan | null>("scholarly_scan_latest")); break; }
        setScan(await scholarlyInvoke<LibraryLinkScan | null>("scholarly_scan_latest"));
        const requestId = scholarlyRequestId(); scanRequest.current = requestId;
        let candidates: PaperMatchCandidate[] = []; let error = "";
        try {
          const document = stateRef.current.documents.find((d) => d.id === documentId);
          if (!document) throw new Error("문서가 삭제되었습니다.");
          const text = await localPaperSeed(document, stateRef.current);
          if (scanStop.current) throw new Error("CANCELLED");
          const result = await scholarlyInvoke<CandidatePage>("scholarly_candidates", { documentId, query: "", text, requestId });
          candidates = result.candidates; error = result.pauseReason;
        } catch (e) { error = String(e); if (error.includes("CANCELLED")) error = "CANCELLED"; }
        scanRequest.current = "";
        setScan(await scholarlyInvoke<LibraryLinkScan>("scholarly_scan_finish", { scanId: job.id, documentId, candidates, error }));
        if (/RATE_LIMIT|AUTH_OR_LIMIT/.test(error)) { scanStop.current = true; setScan(await scholarlyInvoke<LibraryLinkScan>("scholarly_scan_action", { scanId: job.id, action: "pause" })); props.notify(error, "error"); }
      }
    } catch (e) { props.notify(String(e), "error"); setScan(await scholarlyInvoke<LibraryLinkScan | null>("scholarly_scan_action", { scanId: job.id, action: "pause" }).catch(() => null)); }
    finally { scanRunning.current = false; scanRequest.current = ""; }
  }
  async function scanAction(action: string) {
    try {
      if (action === "start") {
        const job = await scholarlyInvoke<LibraryLinkScan>("scholarly_scan_start"); setScan(job); return;
      }
      if (!scan) return;
      if (action === "resume" && scanRunning.current) return;
      if (action !== "resume") { scanStop.current = true; if (scanRequest.current) await cancelScholarly(scanRequest.current); }
      const job = await scholarlyInvoke<LibraryLinkScan>("scholarly_scan_action", { scanId: scan.id, action }); setScan(job);
      if (action === "resume") void runScan(job);
    } catch (e) { props.notify(String(e), "error"); }
  }
  const value: ScholarlyContextValue = { state: props.state, ko, identities, revision, scan, scanAction, openLink, importPaper, onOpen: props.onOpen, onDocumentChanged: props.onDocumentChanged, notify: props.notify, saveSetting: props.saveSetting, updateIdentities };
  return <ScholarlyContext.Provider value={value}>
    {props.children}
    <div className="scholarly-overlays" data-theme={props.state.settings.theme}>
    {dialog && <div className="scholarly-modal-backdrop" role="presentation"><section className="scholarly-link-dialog" role="dialog" aria-modal="true" aria-labelledby="scholarly-link-title">
      <div className="scholarly-heading"><div><h2 id="scholarly-link-title">{ko ? "온라인 정보 연결" : "Link online paper"}</h2><p>{dialog.document.title}</p></div>
        <button onClick={() => { void cancelScholarly(dialog.requestId); setDialog(null); dialogRef.current = null; }}>{ko ? "닫기" : "Close"}</button></div>
      <form className="scholarly-search-row" onSubmit={(e) => {
        e.preventDefault(); void cancelScholarly(dialog.requestId); const requestId = scholarlyRequestId();
        const next = { ...dialog, requestId, loading: true, error: "", candidates: [], selected: -1, fields: [] }; dialogRef.current = next; setDialog(next);
        void searchCandidates(dialog.document, dialog.query, requestId);
      }}><input aria-label={ko ? "논문 후보 검색" : "Search paper candidates"} placeholder={ko ? "제목, DOI 또는 arXiv URL/ID" : "Title, DOI or arXiv URL/ID"} value={dialog.query} onChange={(e) => setDialog({ ...dialog, query: e.target.value })} /><button disabled={dialog.loading}>{ko ? "후보 검색" : "Find candidates"}</button></form>
      {dialog.loading && <p role="status">{ko ? "처리 중…" : "Working…"}</p>}
      {dialog.error && <p role="alert" className="scholarly-error">{dialog.error}</p>}
      {dialog.notice && <p className="muted">{dialog.notice}</p>}
      {!dialog.loading && !dialog.error && !dialog.candidates.length && <p>{ko ? "후보를 찾지 못했습니다. URL/ID 또는 제목으로 검색해 주세요." : "No candidates. Try a URL/ID or title."}</p>}
      <div className="scholarly-candidates">{dialog.candidates.map((c, index) => <button key={`${c.paper.arxivId}-${c.paper.openAlexId}-${index}`} className={dialog.selected === index ? "scholarly-candidate selected" : "scholarly-candidate"} onClick={() => setDialog({ ...dialog, selected: index, fields: emptyMetadataFields(dialog.document, c.paper) })} disabled={dialog.loading}>
        <strong>{c.paper.title}</strong><span>{c.paper.authors} · {c.paper.year} · {c.paper.source}</span><span>{ko ? c.evidence : (c.identifierMatch ? "PDF identifier match" : "Compare title, authors and year")}</span>
        <span>{c.paper.arxivId ? `arXiv:${c.paper.arxivId}${c.paper.version ? `v${c.paper.version}` : ""}` : c.paper.doi || c.paper.openAlexId}</span>
      </button>)}</div>
      {dialog.selected >= 0 && <><table className="scholarly-compare"><thead><tr><th>{ko ? "적용" : "Apply"}</th><th>{ko ? "현재 정보" : "Current"}</th><th>{ko ? "온라인 정보" : "Online"}</th></tr></thead><tbody>{(["title", "authors", "year", "abstractText"] as const).map((field) => <tr key={field}><td><label><input type="checkbox" checked={dialog.fields.includes(field)} disabled={dialog.loading} onChange={(e) => setDialog({ ...dialog, fields: e.target.checked ? [...dialog.fields, field] : dialog.fields.filter((f) => f !== field) })} />{({ title: ko ? "제목" : "Title", authors: ko ? "저자" : "Authors", year: ko ? "연도" : "Year", abstractText: ko ? "초록" : "Abstract" })[field]}</label></td><td>{dialog.document[field] || "—"}</td><td>{dialog.candidates[dialog.selected].paper[field] || "—"}</td></tr>)}</tbody></table>
        <p className="muted">{ko ? "선택한 필드만 변경합니다. 로컬 PDF와 주석은 유지됩니다." : "Only selected metadata fields will change. PDF and annotations are preserved."}</p>
        <div className="scholarly-actions"><button disabled={dialog.loading} onClick={() => void openExternalUrl(dialog.candidates[dialog.selected].paper.url)}>{ko ? "원문 확인" : "View source"}</button><button className="primary" disabled={dialog.loading} onClick={() => void applyLink()}>{ko ? "이 논문으로 연결" : "Confirm paper"}</button></div></>}
    </section></div>}
    {download && <section className="scholarly-download" role="status"><strong>{download.title}</strong>{download.error ? <><p role="alert">{download.error}</p><button onClick={() => { downloadRef.current = null; void importPaper(download.paper); }}>{ko ? "재시도" : "Retry"}</button><button onClick={() => { setDownload(null); downloadRef.current = null; }}>{ko ? "닫기" : "Close"}</button></> : <><progress max={download.total ?? undefined} value={download.total ? download.downloaded : undefined} /><span>{(download.downloaded / 1048576).toFixed(1)} MB {download.total ? `/ ${(download.total / 1048576).toFixed(1)} MB` : ""}</span><button onClick={() => void cancelScholarly(download.id)}>{ko ? "취소" : "Cancel"}</button></>}</section>}
    </div>
  </ScholarlyContext.Provider>;
}
