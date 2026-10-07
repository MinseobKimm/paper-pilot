import { useEffect, useRef, useState } from "react";
import { X, Download, BookOpen } from "../icons";
import { useScholarly } from "../ScholarlyWorkspace";
import { ownedPaper } from "../../lib/scholarlyService";
import { openExternalUrl } from "../../lib/scholarly";
import { wordPopupPosition } from "../../lib/wordPopupPosition";
import type { PaperCitation } from "../../lib/paperCitations";
import type { CitationPopup } from "../../hooks/usePaperCitations";

export function CitationPopover(props: { popup: CitationPopup; reference: PaperCitation; onClose: () => void; onRetry: () => Promise<void> }) {
  const ctx = useScholarly(); const { ko } = ctx;
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: props.popup.x, top: props.popup.y });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const place = () => setPosition(wordPopupPosition(props.popup.x, props.popup.y, node.offsetWidth, node.offsetHeight, window.innerWidth, window.innerHeight));
    const observer = new ResizeObserver(place); observer.observe(node); place();
    window.addEventListener("resize", place);
    const outside = (event: PointerEvent) => { if (!node.contains(event.target as Node)) props.onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape); };
  }, [props.popup.referenceId, props.popup.x, props.popup.y]);
  const reference = props.reference;
  return <div ref={element} className="citation-popover" style={position} role="dialog" aria-label={ko ? "인용 논문 정보" : "Cited paper information"}>
    <div className="citation-popover-head"><strong>{props.popup.label}</strong><button aria-label={ko ? "닫기" : "Close"} onClick={props.onClose}><X size={17} /></button></div>
    {reference.status !== "found" && <><h3>{reference.title}</h3><p className="citation-popover-meta">{reference.authors} · {reference.year}</p></>}
    {reference.status === "pending" && <p role="status">{ko ? "arXiv에서 논문 정보를 찾는 중…" : "Looking up this paper on arXiv…"}</p>}
    {reference.status === "not-found" && <p>{ko ? "arXiv에서 일치하는 논문을 찾지 못했습니다. 참고문헌의 정보는 위와 같습니다." : "No matching arXiv paper was found. The bibliography information is shown above."}</p>}
    {reference.status === "error" && <p role="alert" className="citation-popover-error">{reference.error}</p>}
    {reference.papers.length > 1 && <p className="citation-popover-meta">{ko ? "검색 후보 · 제목과 저자를 확인해 주세요." : "Candidates · compare the title and authors."}</p>}
    {reference.papers.map((paper) => {
      const owned = ownedPaper(paper, ctx.identities);
      return <article className="citation-popover-paper" key={`${paper.arxivId}:${paper.version}`}>
        <h3>{paper.title}</h3><p className="citation-popover-meta">{paper.authors}</p>
        <p className="citation-popover-meta">{paper.published.slice(0, 10) || paper.year} · arXiv:{paper.arxivId}{paper.version ? `v${paper.version}` : ""}</p>
        {paper.categories.length > 0 && <p className="citation-popover-meta">{paper.categories.join(" · ")}</p>}
        {paper.abstractText && <details><summary>{ko ? "초록 보기" : "Abstract"}</summary><p>{paper.abstractText}</p></details>}
        <div className="citation-popover-actions"><button onClick={() => void openExternalUrl(paper.url)}>arXiv</button><button className="primary" disabled={busy || Boolean(owned)} onClick={async () => { setBusy(true); try { await ctx.importPaper(paper, { openAfterImport: false }); } finally { setBusy(false); } }}>
          {owned ? <BookOpen size={15} /> : <Download size={15} />}{owned ? (ko ? "라이브러리에 있음" : "In library") : busy ? (ko ? "추가 중…" : "Adding…") : (ko ? "라이브러리에 추가" : "Add to library")}
        </button></div>
      </article>;
    })}
    <details className="citation-popover-reference"><summary>{ko ? "참고문헌 원문" : "Bibliography entry"}</summary><p>{reference.rawReference}</p></details>
    {(reference.status === "not-found" || reference.status === "error") && <button disabled={busy} onClick={async () => { setBusy(true); try { await props.onRetry(); } finally { setBusy(false); } }}>{busy ? (ko ? "조회 중…" : "Loading…") : (ko ? "arXiv 조회 다시 시도" : "Retry arXiv lookup")}</button>}
  </div>;
}
