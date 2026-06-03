import type { CitationCardRecord, PageRecord } from "../types";
import { makeId, nowIso } from "./ids";

const yearPattern = /\b(19|20)\d{2}\b/;
const doiPattern = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i;
const urlPattern = /https?:\/\/\S+/i;
const referenceHeadingPattern = /\b(references|bibliography|works cited|literature cited)\b/i;
const referenceMarkerPattern = /^(?:\[\d{1,3}\]|\d{1,3}[.)])\s+/;
const authorStartPattern = /^[A-Z][A-Za-z'\u2019-]+(?:,\s*(?:[A-Z]\.|[A-Z][A-Za-z'\u2019-]+)|\s+(?:and|&)\s+[A-Z][A-Za-z'\u2019-]+| et al\.?)/;

function normalizeReferenceText(value: string) {
  return value
    .replace(/\r/g, "\n")
    .replace(/\u00ad/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function stripReferenceMarker(value: string) {
  return value
    .replace(referenceHeadingPattern, "")
    .replace(referenceMarkerPattern, "")
    .replace(/\s+/g, " ")
    .replace(/^[,.;:\-\s]+|[,.;:\-\s]+$/g, "")
    .trim();
}

function referenceSectionText(pages: PageRecord[]) {
  const text = normalizeReferenceText(pages.map((page) => page.text).join("\n"));
  const marker = text.search(referenceHeadingPattern);
  const source = marker >= 0 ? text.slice(marker) : normalizeReferenceText(pages.slice(-4).map((page) => page.text).join("\n"));
  if (marker < 0) {
    return source;
  }
  const stop = source.slice(80).search(/\b(appendix|supplementary material|acknowledg(?:e)?ments?)\b/i);
  return stop >= 0 ? source.slice(0, stop + 80) : source;
}

function addSyntheticReferenceBreaks(source: string) {
  return source
    .replace(/\s*(\[\d{1,3}\])\s+/g, "\n$1 ")
    .replace(/\s+(\d{1,3}[.)])\s+(?=[A-Z][A-Za-z'\u2019-]+(?:,|\s+and\s+|\s+&\s+| et al\.?))/g, "\n$1 ");
}

function looksLikeReferenceStart(line: string) {
  const clean = line.trim();
  return referenceMarkerPattern.test(clean) || authorStartPattern.test(clean);
}

function sentencePieces(source: string) {
  return source.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [source];
}

function splitUnmarkedReferences(source: string) {
  const pieces = sentencePieces(source.replace(/\n+/g, " "));
  const references: string[] = [];
  let current = "";
  for (let index = 0; index < pieces.length; index += 1) {
    current = current ? `${current} ${pieces[index]}` : pieces[index];
    const next = pieces[index + 1] ?? "";
    const canClose =
      yearPattern.test(current) &&
      current.length > 80 &&
      (doiPattern.test(current) || urlPattern.test(current) || (current.split(/[.!?]/).length >= 3 && authorStartPattern.test(next)));
    if (canClose) {
      references.push(current);
      current = "";
    }
  }
  if (current.trim()) {
    references.push(current);
  }
  return references;
}

function splitCandidateReferences(source: string) {
  const brokenLines = addSyntheticReferenceBreaks(source)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const references: string[] = [];
  let current = "";
  for (const line of brokenLines) {
    if (looksLikeReferenceStart(line) && current) {
      references.push(current);
      current = line;
    } else {
      current = current ? `${current} ${line}` : line;
    }
  }
  if (current) {
    references.push(current);
  }
  if (references.length <= 1) {
    return splitUnmarkedReferences(source);
  }
  return references;
}

function mathNoiseRatio(value: string) {
  const symbols = value.match(/[=<>^_{}\\|+\-*/\u2200-\u22ff]/g)?.length ?? 0;
  return symbols / Math.max(1, value.length);
}

function isLikelyReference(rawReference: string) {
  const clean = stripReferenceMarker(rawReference);
  if (clean.length < 36 || clean.length > 1800 || !yearPattern.test(clean)) {
    return false;
  }
  if (/^(abstract|introduction|method|results?|discussion|figure|fig\.|table|equation|algorithm)\b/i.test(clean)) {
    return false;
  }
  const words = clean.match(/[A-Za-z][A-Za-z'\u2019-]{2,}/g) ?? [];
  if (words.length < 6) {
    return false;
  }
  const compactMathRuns = clean.match(/\b[A-Za-z]\s*[=<>]\s*[A-Za-z0-9]|\b(?:arg|min|max|sum|prod|lim)\b|\\[A-Za-z]+|[_^]{2,}/gi) ?? [];
  if (mathNoiseRatio(clean) > 0.08 || compactMathRuns.length > 1) {
    return false;
  }
  const hasMarker = referenceMarkerPattern.test(rawReference.trim());
  const hasDoiOrUrl = doiPattern.test(clean) || urlPattern.test(clean);
  const hasAuthorSignal = /(?:,\s*[A-Z]\.| et al\.|\s+and\s+[A-Z][A-Za-z'\u2019-]+|\s+&\s+[A-Z][A-Za-z'\u2019-]+)/.test(clean);
  const hasVenueSignal = /\b(journal|conference|proceedings|transactions|arxiv|press|nature|science|acm|ieee|springer|elsevier|neurips|icml|iclr|cvpr|acl|emnlp)\b/i.test(clean);
  return hasMarker || hasDoiOrUrl || (hasAuthorSignal && clean.split(/[.!?]/).length >= 2) || hasVenueSignal;
}

function cleanReference(rawReference: string) {
  return stripReferenceMarker(rawReference)
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function referenceKey(rawReference: string) {
  return cleanReference(rawReference).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function referenceTitle(rawReference: string) {
  const clean = cleanReference(rawReference);
  const parts = clean.split(/[.!?]\s+/).map((part) => part.trim()).filter(Boolean);
  const yearIndex = parts.findIndex((part) => yearPattern.test(part));
  const title = yearIndex >= 0 && parts[yearIndex + 1] ? parts[yearIndex + 1] : parts[1] ?? parts[0] ?? clean;
  return title.replace(/^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019]+$/g, "").slice(0, 180);
}

function referenceAuthors(rawReference: string) {
  const clean = cleanReference(rawReference);
  const firstSentence = clean.split(/[.!?]\s+/)[0] ?? clean;
  return firstSentence.replace(/\(?\b(19|20)\d{2}\b\)?\.?/, "").replace(/\s+/g, " ").trim().slice(0, 180);
}

export function extractReferences(documentId: string, pages: PageRecord[]): CitationCardRecord[] {
  const seen = new Set<string>();
  const unique = splitCandidateReferences(referenceSectionText(pages))
    .filter((rawReference) => {
      if (!isLikelyReference(rawReference)) {
        return false;
      }
      const key = referenceKey(rawReference);
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .map(cleanReference)
    .slice(0, 80);
  return unique.map((rawReference) => {
    const year = rawReference.match(yearPattern)?.[0] ?? "";
    const doi = rawReference.match(doiPattern)?.[0] ?? "";
    const url = rawReference.match(urlPattern)?.[0] ?? "";
    const title = referenceTitle(rawReference);
    const authors = referenceAuthors(rawReference);
    const key = `${authors.split(/\s+/)[0] ?? "ref"}${year}`.replace(/[^A-Za-z0-9]/g, "");
    return {
      id: makeId("cite"),
      documentId,
      rawReference,
      title,
      authors,
      year,
      doi,
      url,
      reason: "",
      bibtex: `@article{${key || "reference"},\n  title={${title}},\n  author={${authors}},\n  year={${year}}\n}`,
      createdAt: nowIso(),
    };
  });
}

export function citationCardsToCsv(cards: CitationCardRecord[]): string {
  const header = ["title", "authors", "year", "doi", "url", "reason", "rawReference"];
  const rows = cards.map((card) =>
    header
      .map((key) => {
        const value = String(card[key as keyof CitationCardRecord] ?? "");
        return `"${value.replace(/"/g, '""')}"`;
      })
      .join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

export function citationCardsToBibtex(cards: CitationCardRecord[]): string {
  return cards.map((card) => card.bibtex || card.rawReference).join("\n\n");
}
