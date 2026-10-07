import type { AiResultRecord, PageRecord } from "../types";
import type { TextLayerBox } from "./pdfText";
import type { ScholarlyPaper } from "../types/scholarly";
import { cleanAiOutput, parseAiJson, stripJsonFence } from "./textUtils";

export const citationIndexVersion = "1";
export const citationIndexKey = (documentId: string) => `paperCitationIndex:${documentId}`;
export type PaperCitation = {
  id: string; title: string; authors: string; year: string; arxivId: string; rawReference: string;
  citations: Array<{ page: number; text: string }>;
  status: "pending" | "found" | "not-found" | "error";
  papers: ScholarlyPaper[]; error: string;
};
export type PaperCitationIndex = { version: string; resultId: string; references: PaperCitation[] };
export type CitationHit = { id: string; referenceId: string; text: string; rect: { left: number; top: number; width: number; height: number } };

export function hasBlockingCitationIndexTask(results: AiResultRecord[], documentId: string) {
  return results.some((result) => result.documentId === documentId && result.taskType === "indexPaperCitations" &&
    result.inputText === `[citation index v${citationIndexVersion}]` &&
    (result.status === "complete" || (result.status === "pending" && Date.now() - Date.parse(result.createdAt) < 20 * 60_000)));
}

function foldedText(text: string) {
  let value = "";
  const offsets: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s|\u00ad/.test(text[i]) || (text[i] === "-" && /^\s+[a-z]/.test(text.slice(i + 1)))) continue;
    const next = text[i].normalize("NFKC").toLowerCase();
    value += next;
    for (let j = 0; j < next.length; j++) offsets.push(i);
  }
  return { value, offsets };
}

export function citationIndexFromSettings(settings: Record<string, string>, documentId: string): PaperCitationIndex | null {
  try {
    const value = JSON.parse(settings[citationIndexKey(documentId)] || "null");
    return value?.version === citationIndexVersion && typeof value.resultId === "string" && Array.isArray(value.references) ? value : null;
  } catch { return null; }
}

/** Accept only links to text that actually exists in the PDF, including wrapped citations. */
export function parsePaperCitationIndex(output: string, pages: PageRecord[]): PaperCitation[] {
  const value = parseAiJson(stripJsonFence(cleanAiOutput(output))) as { references?: unknown[] };
  if (!Array.isArray(value?.references)) throw new Error("인용 연결 결과 형식을 읽지 못했습니다.");
  const pageTexts = new Map(pages.map((page) => [page.pageNumber, foldedText(page.text).value]));
  const wholeText = [...pageTexts.values()].join("");
  const references: PaperCitation[] = [];
  for (const item of value.references) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    const rawReference = typeof row.rawReference === "string" ? row.rawReference.trim() : "";
    if (!title || title.length > 1000 || !rawReference || rawReference.length > 5000 ||
        !wholeText.includes(foldedText(title).value) || !wholeText.includes(foldedText(rawReference).value)) continue;
    const citations = (Array.isArray(row.citations) ? row.citations : []).flatMap((citation) => {
      const page = Number(citation?.page);
      const text = typeof citation?.text === "string" ? citation.text.trim() : "";
      return text.length > 1 && text.length <= 200 && pageTexts.get(page)?.includes(foldedText(text).value) ? [{ page, text }] : [];
    });
    if (!citations.length) continue;
    const previous = references.find((reference) => foldedText(reference.rawReference).value === foldedText(rawReference).value);
    if (previous) { previous.citations.push(...citations); continue; }
    const arxivId = typeof row.arxivId === "string" && rawReference.includes(row.arxivId) ? row.arxivId.trim() : "";
    references.push({ id: `ref-${references.length + 1}`, title, rawReference, arxivId,
      authors: typeof row.authors === "string" ? row.authors.slice(0, 1000) : "",
      year: typeof row.year === "string" ? row.year : "",
      citations, status: "pending", papers: [], error: "" });
  }
  if (value.references.length && !references.length) throw new Error("PDF 원문과 일치하는 인용 연결을 찾지 못했습니다.");
  return references;
}

export function paperCitationTargets(page: number, text: string, boxes: TextLayerBox[], references: PaperCitation[]): CitationHit[] {
  const source = foldedText(text);
  const hits: CitationHit[] = [];
  const used = new Set<string>();
  for (const reference of references) {
    for (const citation of reference.citations.filter((item) => item.page === page)) {
      const needle = foldedText(citation.text).value;
      if (!needle) continue;
      let at = source.value.indexOf(needle);
      while (at >= 0) {
        const start = source.offsets[at];
        const end = source.offsets[at + needle.length - 1] + 1;
        for (const box of boxes.filter((item) => item.end > start && item.start < end)) {
          const key = `${reference.id}:${start}:${end}:${box.start}`;
          if (used.has(key)) continue;
          used.add(key);
          const length = Math.max(1, box.end - box.start);
          const leftRatio = Math.max(0, start - box.start) / length;
          const rightRatio = Math.min(length, end - box.start) / length;
          hits.push({ id: key, referenceId: reference.id, text: citation.text, rect: {
            left: box.rect.left + box.rect.width * leftRatio, top: box.rect.top,
            width: box.rect.width * (rightRatio - leftRatio), height: box.rect.height,
          } });
        }
        at = source.value.indexOf(needle, at + needle.length);
      }
    }
  }
  return hits;
}

export function rankCitationPapers(title: string, papers: ScholarlyPaper[]) {
  const tokens = (text: string) => new Set(text.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").split(" ").filter(Boolean));
  const wanted = tokens(title);
  const score = (paper: ScholarlyPaper) => {
    const actual = tokens(paper.title);
    const overlap = [...wanted].filter((token) => actual.has(token)).length;
    return overlap / Math.max(1, wanted.size + actual.size - overlap);
  };
  return papers.filter((paper) => score(paper) >= 0.6).sort((a, b) => score(b) - score(a)).slice(0, 5);
}
