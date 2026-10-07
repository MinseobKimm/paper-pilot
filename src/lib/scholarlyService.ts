import { invoke } from "@tauri-apps/api/core";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { inferPdfTitleFromPdfItems } from "./pdfText";
import { isTauriRuntime, readDocumentBytes } from "./tauri";
import type { AppStateRecord, DocumentRecord } from "../types";
import type { LinkedIdentity, ScholarlyPaper } from "../types/scholarly";

export async function scholarlyInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) throw new Error("온라인 논문 연동은 macOS 앱에서 이용할 수 있습니다.");
  return invoke<T>(command, args);
}
export function ownedPaper(paper: ScholarlyPaper, identities: LinkedIdentity[]) {
  return identities.find((item) => paper.arxivId
    ? item.arxivId === paper.arxivId && item.localVersion !== null && item.localVersion === paper.version
    : Boolean(paper.openAlexId) && item.openAlexId === paper.openAlexId);
}
export function emptyMetadataFields(document: DocumentRecord, paper: ScholarlyPaper) {
  return (["title", "authors", "year", "abstractText"] as const).filter((field) => !document[field].trim() && paper[field].trim());
}
export function readerAutomaticMetadata(document: DocumentRecord, info: {Title?: string; Author?: string; CreationDate?: string}, automaticTitle: string, pageCount: number, confirmedFields: string[] = []) {
  return { ...document, title: confirmedFields.includes("title") ? document.title : automaticTitle || document.title || info.Title || document.fileName,
    authors: document.authors || (confirmedFields.includes("authors") ? "" : info.Author) || "", year: confirmedFields.includes("year") ? document.year : document.year || info.CreationDate?.match(/(?:19|20)\d{2}/)?.[0] || "", pageCount };
}
export function arxivIdentityFromFileName(fileName: string): { id: string; version: number | null } | null {
  const name = fileName.trim().replace(/\.pdf$/i, "").replace(/(?:\s*\(\d+\)|_+\d+_)$/, "").replace(/^arxiv[\s:_-]*/i, "");
  const match = name.match(/^((?:\d{4}\.\d{4,5}|[a-z][a-z0-9.-]*(?:\.[a-z]{2})?[_/]\d{7}))(?:v([1-9]\d*))?$/i);
  return match ? { id: match[1].replace("_", "/").toLowerCase(), version: match[2] ? Number(match[2]) : null } : null;
}
export async function localPaperSeed(document: DocumentRecord, state: AppStateRecord): Promise<string> {
  const text = state.pages.filter((p) => p.documentId === document.id && p.pageNumber <= 5).sort((a,b) => a.pageNumber-b.pageNumber).map((p) => p.text).join("\n");
  const identity = arxivIdentityFromFileName(document.fileName);
  if (identity) return `arXiv:${identity.id}${identity.version ? `v${identity.version}` : ""}\n${text}`.slice(0, 40000);
  // Reader text may omit rotated arXiv watermarks. Inspect raw PDF items when
  // the cache has no identifiers, so matching does not lose the local version.
  if (text.length >= 200 && /arxiv\s*:|arxiv\.org\/(?:abs|pdf)\/|10\.\d{4,9}\//i.test(text)) return text.slice(0, 40000);
  const bytes = await readDocumentBytes(document.id);
  const loading = pdfjs.getDocument({ data: bytes });
  try {
    const pdf = await loading.promise;
    const metadata = await pdf.getMetadata().catch(() => ({ info: {} }));
    const lines = [JSON.stringify(metadata.info ?? {})];
    let inferredTitle = "";
    for (let page = 1; page <= Math.min(5, pdf.numPages); page++) {
      const pdfPage = await pdf.getPage(page);
      const content = await pdfPage.getTextContent();
      if (page === 1) inferredTitle = inferPdfTitleFromPdfItems(content.items.filter((item) => "str" in item), pdfPage.getViewport({ scale: 1 }), 1);
      lines.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    }
    const metadataTitle = (metadata.info as { Title?: string }).Title || "";
    const title = inferredTitle || (/^(untitled|microsoft word|document)/i.test(metadataTitle) ? "" : metadataTitle);
    return [`PAPER_PILOT_TITLE:${title.replace(/\s+/g, " ")}`, ...lines].join("\n").slice(0, 40000);
  } finally { await loading.destroy(); }
}
export const scholarlyRequestId = () => crypto.randomUUID();
export const cancelScholarly = (requestId: string) => scholarlyInvoke<void>("scholarly_cancel", { requestId });
