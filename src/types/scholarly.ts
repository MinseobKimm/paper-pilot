export type ScholarlyPaper = {
  title: string; authors: string; year: string; abstractText: string;
  arxivId: string; version: number | null; doi: string; openAlexId: string;
  categories: string[]; published: string; updated: string; journalRef: string;
  url: string; pdfUrl: string; source: string; citedByCount: number | null;
  referencedWorks: string[]; relatedWorks: string[];
};
export type DocumentScholarlyProfile = {
  documentId: string; paper: ScholarlyPaper; localVersion: number | null;
  fetchedAt: string; confirmedFields: string[]; enrichmentError: string;
  arxivFetchedAt: string; openAlexFetchedAt: string;
};
export type PaperMatchCandidate = { paper: ScholarlyPaper; evidence: string; identifierMatch: boolean };
export type CandidatePage = { candidates: PaperMatchCandidate[]; notice: string; localVersion: number | null; pauseReason: string };
export type PaperPage = { papers: ScholarlyPaper[]; total: number; page: number; fetchedAt: string; stale: boolean; notice: string };
export type LinkedIdentity = { documentId: string; arxivId: string; localVersion: number | null; openAlexId: string };
export type SearchRequest = { query: string; category: string; from: string; at: string; sort: string; page: number; requestId: string; refresh: boolean };
export type LibraryLinkScan = { id: string; status: "paused" | "running" | "complete" | "cancelled"; createdAt: string; total: number; completed: number; failed: number };
export type ScanItem = { documentId: string; status: string; candidates: PaperMatchCandidate[]; error: string; ordinal: number };
export type RelationKind = "related" | "references" | "citing";
