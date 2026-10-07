import { useEffect, useRef, useState } from "react";
import { Search, RefreshCw } from "./icons";
import { useScholarly } from "./ScholarlyWorkspace";
import { ArxivPaperCard } from "./ScholarlyPanels";
import { cancelScholarly, scholarlyInvoke, scholarlyRequestId } from "../lib/scholarlyService";
import { isTauriRuntime } from "../lib/tauri";
import type { PaperPage, SearchRequest, ScanItem } from "../types/scholarly";

const categories = ["", "cs.AI", "cs.CL", "cs.LG", "cs.CV", "cs.RO", "cs.IR", "cs.SE", "stat.ML", "math", "physics", "quant-ph", "q-bio", "q-fin", "econ"];
type Filters = { category: string; days: string; sort: string; from: string };
export function DiscoverView() {
  const ctx = useScholarly(); const { ko } = ctx;
  const [tab, setTab] = useState<"search" | "scan">("search");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(() => {
    try { return { category: "", days: "7", sort: "submittedDate", from: "", ...JSON.parse(ctx.state.settings.discoverFilters || "{}") }; }
    catch { return { category: "", days: "7", sort: "submittedDate", from: "" }; }
  });
  const [request, setRequest] = useState<SearchRequest | null>(null);
  const [data, setData] = useState<PaperPage | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const requestRef = useRef("");
  function changeFilters(next: Filters) { setFilters(next); ctx.saveSetting("discoverFilters", JSON.stringify(next)); }
  function search(refresh = false, newQuery = query) {
    const at = new Date().toISOString();
    const from = filters.days === "custom" ? (filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : "") : filters.days === "all" ? "" : new Date(Date.parse(at) - Number(filters.days) * 86400000).toISOString();
    setRequest({ query: newQuery, category: filters.category, from, at, sort: filters.sort, page: 1, requestId: scholarlyRequestId(), refresh });
  }
  useEffect(() => { if (isTauriRuntime()) search(); }, []);
  useEffect(() => {
    if (!request) return;
    const id = request.requestId; requestRef.current = id; setBusy(true); setError(""); setData(null);
    let active = true;
    void scholarlyInvoke<PaperPage>("scholarly_search", { request }).then((result) => { if (active) setData(result); }).catch((e) => { if (active && !String(e).includes("CANCELLED")) setError(String(e)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; void cancelScholarly(id); };
  }, [request]);
  const shownPage = data?.page ?? 1;
  return <section className="discover-view">
    <div className="discover-header"><div><span className="discover-eyebrow">Paper Pilot · arXiv</span><h1>{ko ? "논문 탐색" : "Discover papers"}</h1><p>{ko ? "새로운 연구를 찾고, 내 논문과 연결하세요." : "Find new research and connect your library."}</p></div>
      <div className="scholarly-tabs" role="tablist" aria-label={ko ? "논문 탐색 메뉴" : "Discovery sections"}><button role="tab" aria-selected={tab === "search"} className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>{ko ? "arXiv 검색·피드" : "arXiv search & feed"}</button><button role="tab" aria-selected={tab === "scan"} className={tab === "scan" ? "active" : ""} onClick={() => setTab("scan")}>{ko ? "라이브러리 전체 검사" : "Scan library"}{ctx.scan?.status === "running" ? " •" : ""}</button></div>
    </div>
    {!isTauriRuntime() && <p className="scholarly-notice">{ko ? "검색·다운로드·온라인 연결은 macOS 앱에서 이용할 수 있습니다." : "Search, download and linking are available in the macOS app."}</p>}
    {tab === "search" ? <>
      <form className="discover-search" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <div className="scholarly-search-row"><Search size={19} /><input aria-label={ko ? "arXiv 논문 검색" : "Search arXiv papers"} placeholder={ko ? "제목, 키워드, au:저자 또는 arXiv URL/ID" : "Title, keywords, au:author or arXiv URL/ID"} value={query} onChange={(e) => { const next = e.target.value; setQuery(next); if (!query.trim() && next.trim()) changeFilters({ ...filters, sort: "relevance", days: "all" }); }} /><button className="primary" disabled={busy || !isTauriRuntime()}>{ko ? "검색" : "Search"}</button><button type="button" disabled={busy || !isTauriRuntime()} onClick={() => search(true)} aria-label={ko ? "검색 새로고침" : "Refresh search"}><RefreshCw size={17} /></button></div>
        <div className="discover-filters"><label>{ko ? "분야" : "Category"}<select value={filters.category} onChange={(e) => changeFilters({ ...filters, category: e.target.value })}>{categories.map((value) => <option key={value} value={value}>{value || (ko ? "전체 분야" : "All categories")}</option>)}</select></label>
          <label>{ko ? "제출 기간" : "Submitted"}<select value={filters.days} onChange={(e) => changeFilters({ ...filters, days: e.target.value })}><option value="7">{ko ? "최근 7일" : "Last 7 days"}</option><option value="30">{ko ? "최근 30일" : "Last 30 days"}</option><option value="90">{ko ? "최근 90일" : "Last 90 days"}</option><option value="all">{ko ? "전체 기간" : "All time"}</option><option value="custom">{ko ? "시작일 지정" : "Custom start"}</option></select></label>
          {filters.days === "custom" && <label>{ko ? "시작일" : "From"}<input type="date" value={filters.from} max={new Date().toLocaleDateString("en-CA")} onChange={(e) => changeFilters({ ...filters, from: e.target.value })} /></label>}
          <label>{ko ? "정렬" : "Sort"}<select value={filters.sort} onChange={(e) => changeFilters({ ...filters, sort: e.target.value })}><option value="relevance">{ko ? "관련도" : "Relevance"}</option><option value="submittedDate">{ko ? "최신 제출" : "Newest submitted"}</option><option value="lastUpdatedDate">{ko ? "최신 수정" : "Newest updated"}</option></select></label>
          <button type="button" disabled={busy || !isTauriRuntime()} onClick={() => { setQuery(""); const next = { ...filters, days: "7", sort: "submittedDate" }; changeFilters(next); const at = new Date().toISOString(); setRequest({ query: "", category: next.category, from: new Date(Date.parse(at)-7*86400000).toISOString(), at, sort: next.sort, page: 1, requestId: scholarlyRequestId(), refresh: false }); }}>{ko ? "최신 피드" : "Latest feed"}</button>
        </div>
      </form>
      <div className="discover-results-header"><span>{busy ? (ko ? "논문을 찾는 중…" : "Searching…") : data ? `${data.total.toLocaleString()} ${ko ? "편" : "papers"}` : ""}</span>{request && <small>{ko ? "기준 시각" : "As of"}: {new Date(request.at).toLocaleString()}</small>}{busy && <button onClick={() => { void cancelScholarly(requestRef.current); setRequest(null); setBusy(false); }}>{ko ? "취소" : "Cancel"}</button>}</div>
      {error && <div role="alert" className="scholarly-error">{error}<button disabled={busy} onClick={() => request && setRequest({ ...request, requestId: scholarlyRequestId() })}>{ko ? "재시도" : "Retry"}</button></div>}
      {data?.notice && <p className="scholarly-notice">{data.notice} · {new Date(data.fetchedAt).toLocaleString()}</p>}
      <div className="discover-results" aria-busy={busy}>{data?.papers.map((paper) => <ArxivPaperCard key={`${paper.arxivId}-${paper.version}`} paper={paper} />)}{data && !data.papers.length && !busy && <div className="discover-empty"><Search size={30} /><h3>{ko ? "검색 결과가 없습니다." : "No results found."}</h3><p>{ko ? "키워드나 기간·분야 필터를 바꿔 보세요." : "Try different keywords or filters."}</p></div>}</div>
      {data && request && <div className="scholarly-pagination"><button disabled={busy || shownPage <= 1} onClick={() => setRequest({ ...request, page: shownPage-1, requestId: scholarlyRequestId(), refresh: false })}>{ko ? "이전" : "Previous"}</button><span>{shownPage} / {Math.max(1, Math.ceil(data.total/20))}</span><button disabled={busy || shownPage*20 >= data.total} onClick={() => setRequest({ ...request, page: shownPage+1, requestId: scholarlyRequestId(), refresh: false })}>{ko ? "다음" : "Next"}</button><small>{ko ? "조회" : "Fetched"}: {new Date(data.fetchedAt).toLocaleString()}</small></div>}
    </> : <LibraryScanPanel />}
  </section>;
}
export function LibraryScanPanel() {
  const ctx = useScholarly(); const { ko, scan } = ctx;
  const [items, setItems] = useState<ScanItem[]>([]); const [page, setPage] = useState(1); const [error, setError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  useEffect(() => {
    let active = true;
    if (!scan) { setItems([]); return; }
    void scholarlyInvoke<ScanItem[]>("scholarly_scan_items", { scanId: scan.id, page }).then((data) => { if (active) {setItems(data); setError("");} }).catch((e) => { if (active) setError(String(e)); });
    return () => {active = false;};
  }, [scan, page, ctx.revision]);
  async function action(name: string) { setActionBusy(true); await ctx.scanAction(name); setActionBusy(false); }
  const labels: Record<string, string> = ko ? { pending: "대기", searching: "검색 중", review: "검토 필요", notFound: "미발견", failed: "실패", linked: "연결 완료", paused: "일시정지", running: "진행 중", complete: "검사 완료", cancelled: "취소됨" } : { pending: "Pending", searching: "Searching", review: "Review", notFound: "Not found", failed: "Failed", linked: "Linked", paused: "Paused", running: "Running", complete: "Complete", cancelled: "Cancelled" };
  return <div className="library-scan"><div className="scholarly-scan-intro"><h2>{ko ? "내 논문의 온라인 연결 후보 찾기" : "Find online matches for your library"}</h2><p>{ko ? "검사 시작 시 연결되지 않은 논문을 대상으로 합니다. 후보를 찾은 뒤 각 논문을 확인해 연결하세요. PDF 앞부분은 로컬에서 읽고 식별자와 서지정보로 검색합니다." : "Scans papers that are unlinked when the scan starts. Review and confirm each match. PDF pages are read locally; identifiers and metadata are used for searches."}</p>
      <button className="primary" disabled={actionBusy || !isTauriRuntime() || scan?.status === "running" || scan?.status === "paused"} onClick={() => void action("start")}>{ko ? "새 전체 검사 준비" : "Prepare new scan"}</button></div>
    {scan && <><div className="scholarly-scan-controls"><strong>{labels[scan.status]} · {scan.completed}/{scan.total}</strong><progress max={Math.max(1,scan.total)} value={scan.completed} />
      {scan.status === "paused" && <button disabled={actionBusy} onClick={() => void action("resume")}>{ko ? "검사 시작·재개" : "Start / resume"}</button>}
      {scan.status === "running" && <button disabled={actionBusy} onClick={() => void action("pause")}>{ko ? "일시정지" : "Pause"}</button>}
      {scan.failed > 0 && scan.status !== "cancelled" && <button disabled={actionBusy || scan.status === "running"} onClick={() => void action("retry")}>{ko ? `실패 ${scan.failed}편 재시도 준비` : `Retry ${scan.failed} failures`}</button>}
      {!["cancelled", "complete"].includes(scan.status) && <button disabled={actionBusy} onClick={() => void action("cancel")}>{ko ? "검사 취소" : "Cancel scan"}</button>}</div>
      {error && <p className="scholarly-error" role="alert">{error}</p>}
      <div className="scan-items">{items.map((item) => {
        const doc = ctx.state.documents.find((d) => d.id === item.documentId);
        return <article key={item.documentId} className="scan-item"><span className={`scan-status ${item.status}`}>{labels[item.status] ?? item.status}</span><div><strong>{doc?.title || item.documentId}</strong><p>{item.error || (item.candidates.length ? `${item.candidates.length} ${ko ? "개 후보" : "candidates"}` : "")}</p></div>
          {doc && <button onClick={() => ctx.openLink(doc, item.candidates.length ? item.candidates : undefined)} disabled={item.status === "searching"}>{ko ? "후보 확인·연결" : "Review / link"}</button>}
        </article>;
      })}</div>
      {!scan.total && <p>{ko ? "검사할 미연결 논문이 없습니다." : "No unlinked papers to scan."}</p>}
      <div className="scholarly-pagination"><button disabled={page <= 1} onClick={() => setPage(page-1)}>{ko ? "이전" : "Previous"}</button><span>{page} / {Math.max(1,Math.ceil(scan.total/20))}</span><button disabled={page*20 >= scan.total} onClick={() => setPage(page+1)}>{ko ? "다음" : "Next"}</button></div>
    </>}
  </div>;
}
