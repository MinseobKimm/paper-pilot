import type { CitationCardRecord, DocumentRecord } from "../types";

const openAlexApi = "https://api.openalex.org";
const doiPrefix = "https://doi.org/";

type OpenAlexAuthor = {
  author?: {
    display_name?: string;
  };
};

type OpenAlexWork = {
  id?: string;
  doi?: string | null;
  display_name?: string;
  title?: string;
  publication_year?: number;
  cited_by_count?: number;
  authorships?: OpenAlexAuthor[];
  primary_location?: {
    landing_page_url?: string | null;
    pdf_url?: string | null;
    source?: {
      display_name?: string;
    } | null;
  } | null;
  open_access?: {
    oa_url?: string | null;
  } | null;
  ids?: {
    openalex?: string;
    doi?: string;
  };
};

type OpenAlexListResponse = {
  results?: OpenAlexWork[];
};

export type ScholarlyPaperLink = {
  title: string;
  authors: string;
  year: string;
  doi: string;
  url: string;
  openAlexId: string;
  source: string;
  citedByCount: number;
};

function cleanDoi(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[)\].,;]+$/g, "");
}

function doiUrl(doi: string) {
  const clean = cleanDoi(doi);
  return clean ? `${doiPrefix}${clean}` : "";
}

function authorsFor(work: OpenAlexWork) {
  return (work.authorships ?? [])
    .map((authorship) => authorship.author?.display_name ?? "")
    .filter(Boolean)
    .slice(0, 4)
    .join(", ");
}

function workToPaper(work: OpenAlexWork): ScholarlyPaperLink | null {
  const title = work.display_name || work.title || "";
  if (!title) {
    return null;
  }
  const doi = cleanDoi(work.doi || work.ids?.doi || "");
  const url =
    work.primary_location?.landing_page_url ||
    work.open_access?.oa_url ||
    work.primary_location?.pdf_url ||
    doiUrl(doi) ||
    work.id ||
    work.ids?.openalex ||
    "";
  return {
    title,
    authors: authorsFor(work),
    year: work.publication_year ? String(work.publication_year) : "",
    doi,
    url,
    openAlexId: work.id || work.ids?.openalex || "",
    source: work.primary_location?.source?.display_name || "OpenAlex",
    citedByCount: Number(work.cited_by_count ?? 0),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`OpenAlex request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function searchOpenAlexWorks(query: string, perPage = 5): Promise<ScholarlyPaperLink[]> {
  const search = query.trim().replace(/\s+/g, " ");
  if (!search) {
    return [];
  }
  const url = `${openAlexApi}/works?search=${encodeURIComponent(search)}&per-page=${perPage}`;
  const data = await fetchJson<OpenAlexListResponse>(url);
  return (data.results ?? []).map(workToPaper).filter(Boolean) as ScholarlyPaperLink[];
}

export async function resolveCitationLink(card: CitationCardRecord): Promise<CitationCardRecord> {
  const doi = cleanDoi(card.doi);
  let matches: ScholarlyPaperLink[] = [];
  if (doi) {
    try {
      const work = await fetchJson<OpenAlexWork>(encodeURI(`${openAlexApi}/works/${doiPrefix}${doi}`));
      const paper = workToPaper(work);
      matches = paper ? [paper] : [];
    } catch {
      matches = [];
    }
  }
  if (matches.length === 0) {
    const query = [card.title, card.authors, card.year].filter(Boolean).join(" ") || card.rawReference;
    matches = await searchOpenAlexWorks(query, 1);
  }
  const paper = matches[0];
  if (!paper) {
    return {
      ...card,
      url: card.url || (doi ? doiUrl(doi) : ""),
      doi: card.doi || doi,
    };
  }
  return {
    ...card,
    title: card.title && card.title.length > 12 ? card.title : paper.title,
    authors: card.authors || paper.authors,
    year: card.year || paper.year,
    doi: card.doi || paper.doi,
    url: paper.url || card.url || doiUrl(paper.doi),
  };
}

export async function findRelatedPapers(document: DocumentRecord, seedText = "", perPage = 8): Promise<ScholarlyPaperLink[]> {
  const seedQuery = [document.title, document.authors, document.year, seedText.slice(0, 600)].filter(Boolean).join(" ");
  const seed = (await searchOpenAlexWorks(seedQuery, 1))[0];
  if (!seed?.openAlexId) {
    return searchOpenAlexWorks(seedQuery, perPage);
  }
  const openAlexWorkId = seed.openAlexId.split("/").pop() || seed.openAlexId;
  try {
    const url = `${openAlexApi}/works?filter=related_to:${encodeURIComponent(openAlexWorkId)}&sort=cited_by_count:desc&per-page=${perPage}`;
    const data = await fetchJson<OpenAlexListResponse>(url);
    const related = (data.results ?? []).map(workToPaper).filter(Boolean) as ScholarlyPaperLink[];
    if (related.length) {
      return related;
    }
  } catch {
    // Search fallback below keeps the UI useful if the relationship query is unavailable.
  }
  return searchOpenAlexWorks(seedQuery, perPage + 1).then((items) => items.filter((item) => item.openAlexId !== seed.openAlexId).slice(0, perPage));
}

export function normalizeExternalUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function openExternalUrl(rawUrl: string): boolean {
  const url = normalizeExternalUrl(rawUrl);
  if (!url) {
    return false;
  }
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}

export function openPaperUrl(paper: Pick<ScholarlyPaperLink, "url" | "doi" | "openAlexId"> | CitationCardRecord) {
  const url = "url" in paper && paper.url ? paper.url : "doi" in paper && paper.doi ? doiUrl(paper.doi) : "openAlexId" in paper ? paper.openAlexId : "";
  return url ? openExternalUrl(url) : false;
}
