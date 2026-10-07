import { useEffect, useRef, useState } from "react";
import { Download, BookOpen, Search, RefreshCw } from "./icons";
import { useScholarly } from "./ScholarlyWorkspace";
import { cancelScholarly, ownedPaper, scholarlyInvoke, scholarlyRequestId } from "../lib/scholarlyService";
import { openExternalUrl } from "../lib/scholarly";
import { isTauriRuntime } from "../lib/tauri";
import type { DocumentRecord } from "../types";
import type { DocumentScholarlyProfile, PaperPage, RelationKind, ScholarlyPaper } from "../types/scholarly";

export function ArxivPaperCard({ paper, compact = false }: { paper: ScholarlyPaper; compact?: boolean }) {
  const ctx = useScholarly(); const { ko } = ctx;
  const [expanded, setExpanded] = useState(false);
  const owned = ownedPaper(paper, ctx.identities);
  const otherVersion = paper.arxivId && ctx.identities.find((i) => i.arxivId === paper.arxivId && i.localVersion !== paper.version);
  return <article className={compact ? "scholarly-paper compact" : "scholarly-paper"}>
    <div className="scholarly-paper-meta"><span className="scholarly-source">{paper.source}</span>{paper.categories.map((c) => <span key={c}>{c}</span>)}{paper.arxivId && <span>{paper.arxivId}{paper.version ? `v${paper.version}` : ""}</span>}{owned && <span className="scholarly-owned">{ko ? "보유 중" : "In library"}</span>}{otherVersion && !owned && <span>{ko ? "다른 버전 보유" : "Another version in library"}</span>}</div>
    <h3>{paper.title}</h3><p className="scholarly-authors">{paper.authors || "—"}</p>
    <div className="scholarly-paper-dates"><span>{ko ? (paper.source === "arXiv" ? "제출" : "발행") : "Published"}: {paper.published?.slice(0,10) || paper.year || "—"}</span>{paper.updated && <span>{ko ? (paper.source === "arXiv" ? "수정" : "레코드 수정") : "Updated"}: {paper.updated.slice(0,10)}</span>}{paper.citedByCount !== null && <span>{ko ? "인용" : "Citations"}: {paper.citedByCount}</span>}</div>
    {paper.abstractText && <><p className={expanded ? "scholarly-abstract expanded" : "scholarly-abstract"}>{paper.abstractText}</p><button className="scholarly-text-button" onClick={() => setExpanded(!expanded)}>{expanded ? (ko ? "초록 접기" : "Less") : (ko ? "초록 더 보기" : "More abstract")}</button></>}
    <div className="scholarly-actions"><button onClick={() => void openExternalUrl(paper.url)}>{ko ? "원문 페이지" : "Source page"}</button>{paper.arxivId && <button className="primary" onClick={() => void ctx.importPaper(paper)} disabled={!isTauriRuntime()}>{owned ? <BookOpen size={15} /> : <Download size={15} />}{owned ? (ko ? "논문 열기" : "Open paper") : (ko ? "PDF 가져오기" : "Import PDF")}</button>}</div>
  </article>;
}
export function OnlinePaperPanel({ document }: { document: DocumentRecord }) {
  const ctx = useScholarly(); const { ko } = ctx;
  const [profile, setProfile] = useState<DocumentScholarlyProfile | null>(null);
  const [tab, setTab] = useState<"metadata" | RelationKind>("metadata");
  const [page, setPage] = useState(1); const [data, setData] = useState<PaperPage | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const requestRef = useRef(""); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (requestRef.current) void cancelScholarly(requestRef.current); }; }, []);
  useEffect(() => {
    let active = true; setError("");
    if (!isTauriRuntime()) return;
    void scholarlyInvoke<DocumentScholarlyProfile | null>("scholarly_profile", { documentId: document.id }).then((p) => { if (active) setProfile(p); }).catch((e) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [document.id, ctx.revision]);
  useEffect(() => { setTab("metadata"); setPage(1); setData(null); setProfile(null); }, [document.id]);
  useEffect(() => {
    setData(null);
    if (tab === "metadata" || !profile) return;
    const requestId = scholarlyRequestId(); requestRef.current = requestId; let active = true; setBusy(true); setError("");
    void scholarlyInvoke<PaperPage>("scholarly_relations", { documentId: document.id, kind: tab, page, requestId, refresh: refreshGeneration > 0 }).then((result) => { if (active) setData(result); }).catch((e) => { if (active && !String(e).includes("CANCELLED")) setError(String(e)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; void cancelScholarly(requestId); };
  }, [document.id, profile?.fetchedAt, profile?.paper.openAlexId, tab, page, refreshGeneration]);
  async function refresh() {
    const documentId = document.id; const requestId = scholarlyRequestId(); requestRef.current = requestId; setBusy(true); setError("");
    try {
      const updated = await scholarlyInvoke<DocumentScholarlyProfile>("scholarly_refresh", { documentId, requestId });
      if (mounted.current) { setProfile(updated); await ctx.updateIdentities(); }
    } catch (e) { if (mounted.current) setError(String(e)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function unlink() {
    setBusy(true); try { await scholarlyInvoke("scholarly_unlink", { documentId: document.id }); setProfile(null); setTab("metadata"); await ctx.updateIdentities(); ctx.notify(ko ? "온라인 연결을 해제했습니다. 서지정보는 유지됩니다." : "Unlinked. Metadata retained."); } catch (e) {setError(String(e));} finally {setBusy(false);}
  }
  const tabs = [{ id: "metadata", label: ko ? "서지정보" : "Metadata" }, { id: "related", label: ko ? "관련 논문" : "Related" }, { id: "references", label: ko ? "참고문헌" : "References" }, { id: "citing", label: ko ? "피인용" : "Citing" }] as const;
  return <section className="online-paper-panel">
    <div className="scholarly-heading"><h3>{ko ? "온라인 논문 정보" : "Online paper information"}</h3><button disabled={busy || !isTauriRuntime()} onClick={() => ctx.openLink(document)}><Search size={14} />{profile ? (ko ? "연결 변경" : "Change link") : (ko ? "온라인 정보 연결" : "Link online paper")}</button></div>
    {error && <p role="alert" className="scholarly-error">{error}</p>}
    {profile ? <><div className="scholarly-tabs" role="tablist" aria-label={ko ? "온라인 정보 종류" : "Online information"}>{tabs.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "active" : ""} onClick={() => {setTab(t.id); setPage(1); setRefreshGeneration(0);}}>{t.label}</button>)}</div>
      {tab === "metadata" ? <><dl className="scholarly-profile"><dt>{ko ? "제목" : "Title"}</dt><dd>{profile.paper.title}</dd><dt>{ko ? "저자" : "Authors"}</dt><dd>{profile.paper.authors}</dd><dt>arXiv</dt><dd>{profile.paper.arxivId || "—"}</dd><dt>DOI</dt><dd>{profile.paper.doi || "—"}</dd><dt>{ko ? "분야" : "Categories"}</dt><dd>{profile.paper.categories.join(", ") || "—"}</dd><dt>{ko ? "로컬 / 최신 버전" : "Local / latest version"}</dt><dd>{profile.localVersion ? `v${profile.localVersion}` : (ko ? "미확인" : "Unknown")} / {profile.paper.version ? `v${profile.paper.version}` : "—"}</dd><dt>{ko ? "학술지" : "Journal"}</dt><dd>{profile.paper.journalRef || "—"}</dd><dt>{ko ? "인용 수" : "Citations"}</dt><dd>{profile.paper.citedByCount === null ? (ko ? "정보 없음" : "Unavailable") : profile.paper.citedByCount}</dd><dt>{ko ? "출처" : "Source"}</dt><dd>{profile.paper.source}{profile.paper.openAlexId && profile.paper.source !== "OpenAlex" ? " + OpenAlex" : ""}</dd><dt>{ko ? "조회 시각" : "Fetched"}</dt><dd>{new Date(profile.fetchedAt).toLocaleString()}</dd></dl>
        <p className="muted">{profile.arxivFetchedAt && `arXiv · ${new Date(profile.arxivFetchedAt).toLocaleString()}`}{profile.arxivFetchedAt && profile.openAlexFetchedAt ? " / " : ""}{profile.openAlexFetchedAt && `OpenAlex · ${new Date(profile.openAlexFetchedAt).toLocaleString()}`}</p>
        {profile.enrichmentError && <p className="scholarly-notice">{profile.enrichmentError}</p>}
        {profile.paper.abstractText && <details><summary>{ko ? "온라인 초록" : "Online abstract"}</summary><p>{profile.paper.abstractText}</p></details>}
        {profile.localVersion !== null && profile.paper.version !== null && profile.paper.version > profile.localVersion && <p className="scholarly-notice">{ko ? `새 버전 v${profile.paper.version}이 있습니다. 가져오면 별도 문서로 저장합니다.` : `Version ${profile.paper.version} is available. Importing creates a separate document.`}</p>}
        <div className="scholarly-actions"><button disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} />{ko ? "온라인 정보 새로고침" : "Refresh information"}</button><button onClick={() => void openExternalUrl(profile.paper.url)}>{ko ? "원문 페이지" : "Source page"}</button>{profile.paper.arxivId && <button disabled={busy} onClick={() => void ctx.importPaper({ ...profile.paper, version: null })}>{ko ? "최신 PDF 가져오기" : "Import latest PDF"}</button>}<button disabled={busy} onClick={() => void unlink()}>{ko ? "연결 해제" : "Unlink"}</button></div>
      </> : <><div className="scholarly-actions"><button disabled={busy} onClick={() => setRefreshGeneration((n) => n+1)}>{ko ? "목록 새로고침" : "Refresh list"}</button></div>{busy && <p role="status">{ko ? "조회 중…" : "Loading…"}</p>}{data?.notice && <p className="scholarly-notice">{data.notice}</p>}{data?.papers.map((p) => <ArxivPaperCard key={p.openAlexId || `${p.arxivId}-${p.version}`} paper={p} compact />)}{data && !data.papers.length && <p>{ko ? "조회된 논문이 없습니다." : "No papers returned."}</p>}{data && <div className="scholarly-pagination"><button disabled={busy || page <= 1} onClick={() => setPage(page-1)}>{ko ? "이전" : "Previous"}</button><span>{page} / {Math.max(1,Math.ceil(data.total/20))}</span><button disabled={busy || page*20 >= data.total} onClick={() => setPage(page+1)}>{ko ? "다음" : "Next"}</button><small>{data.notice.includes("arXiv 제목") ? "arXiv" : "OpenAlex"} · {new Date(data.fetchedAt).toLocaleString()}</small></div>}{tab === "references" && <p className="muted">{ko ? "PDF에서 추출한 참고문헌은 기존 참고문헌 패널에서 확인할 수 있습니다. 온라인 목록은 제공처의 수록 범위에 따라 다를 수 있습니다." : "PDF-extracted references remain in the Citations panel. Online references depend on provider coverage."}</p>}</>}
    </> : <p className="muted">{ko ? "후보를 확인해 연결하면 서지정보와 관련 논문·인용 정보를 가져올 수 있습니다." : "Confirm a paper match to retrieve metadata, related papers and citations."}</p>}
  </section>;
}
export function OpenAlexKeySettings({ ko }: { ko: boolean }) {
  const [saved, setSaved] = useState(false); const [key, setKey] = useState(""); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  useEffect(() => { if (isTauriRuntime()) void scholarlyInvoke<boolean>("scholarly_key_status").then(setSaved).catch((e) => setMessage(String(e))); }, []);
  async function save(value: string) { setBusy(true); setMessage(""); try {await scholarlyInvoke("scholarly_set_key", { key: value }); setKey(""); setSaved(Boolean(value.trim())); setMessage(ko ? "Keychain 설정을 갱신했습니다." : "Keychain updated.");} catch (e) {setMessage(String(e));} finally {setBusy(false);} }
  return <section className="openalex-key-settings"><h3>OpenAlex API</h3><p>{ko ? "인용·관련 논문 조회는 제한된 익명 이용을 지원합니다. API 키를 추가하면 조회 한도를 늘릴 수 있습니다." : "Limited anonymous queries are supported. Add an API key for a larger allowance."}</p><p>{saved ? (ko ? "API 키 저장됨 · macOS Keychain" : "API key saved · macOS Keychain") : (ko ? "API 키 없음 · 익명 조회" : "No API key · anonymous queries")}</p><label className="field"><span>{ko ? "새 API 키" : "New API key"}</span><input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} disabled={busy || !isTauriRuntime()} /></label><div className="scholarly-actions"><button disabled={busy || !key.trim() || !isTauriRuntime()} onClick={() => void save(key)}>{ko ? "Keychain에 저장" : "Save in Keychain"}</button><button disabled={busy || !saved} onClick={() => void save("")}>{ko ? "키 삭제" : "Delete key"}</button><button onClick={() => void openExternalUrl("https://openalex.org/settings/api")}>{ko ? "API 키 발급 페이지" : "Get an API key"}</button></div>{message && <p role="status">{message}</p>}</section>;
}
