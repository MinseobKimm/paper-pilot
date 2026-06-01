import type { CitationCardRecord, PageRecord } from "../types";
import { makeId, nowIso } from "./ids";

const yearPattern = /\b(19|20)\d{2}\b/;
const doiPattern = /\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i;
const urlPattern = /https?:\/\/\S+/i;

export function extractReferences(documentId: string, pages: PageRecord[]): CitationCardRecord[] {
  const text = pages
    .map((page) => page.text)
    .join("\n")
    .replace(/\r/g, "\n");
  const marker = text.search(/\b(references|bibliography)\b/i);
  const source = marker >= 0 ? text.slice(marker) : text;
  const lines = source
    .split(/\n+/)
    .map((line) => line.replace(/^\s*\[\d+\]\s*/, "").trim())
    .filter((line) => line.length > 24 && yearPattern.test(line));

  const unique = [...new Set(lines)].slice(0, 80);
  return unique.map((rawReference) => {
    const year = rawReference.match(yearPattern)?.[0] ?? "";
    const doi = rawReference.match(doiPattern)?.[0] ?? "";
    const url = rawReference.match(urlPattern)?.[0] ?? "";
    const parts = rawReference.split(/[.!?]\s+/);
    const title = parts.length > 1 ? parts[1].slice(0, 180) : rawReference.slice(0, 180);
    const authors = parts[0]?.slice(0, 180) ?? "";
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
