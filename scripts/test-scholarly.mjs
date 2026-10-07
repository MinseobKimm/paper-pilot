import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { pathToFileURL } from "node:url";
const temporary = await mkdtemp(path.join(tmpdir(), "paper-pilot-scholarly-"));
try {
  const output = path.join(temporary, "scholarly.mjs");
  await build({ entryPoints: ["src/lib/scholarlyService.ts"], bundle: true, platform: "node", format: "esm", outfile: output,
    plugins: [{ name: "pdf-runtime", setup(builder) { builder.onResolve({ filter: /^pdfjs-dist/ }, () => ({ path: "pdf-test-runtime", namespace: "pdf-test" })); builder.onLoad({ filter: /.*/, namespace: "pdf-test" }, () => ({ contents: 'export const Util = {}; export function getDocument() { throw new Error("PDF should not be opened for matching cached text"); }' })); } }],
  });
  const lib = await import(pathToFileURL(output));
  const document = { id: "local", title: "User title", authors: "Confirmed author", year: "2020", abstractText: "", fileName: "old.pdf", filePath: "/original/old.pdf", hash: "hash", pageCount: 2, folderId: "root", bookmarked: false, createdAt: "now", updatedAt: "now" };
  const paper = { arxivId: "2401.01234", version: 3, openAlexId: "W1", title: "Online title", authors: "Online author", year: "2024", abstractText: "Abstract" };
  assert.deepEqual(lib.emptyMetadataFields(document, paper), ["abstractText"], "existing metadata must remain unchecked");
  const identities = [{ documentId: "local", arxivId: paper.arxivId, localVersion: 2, openAlexId: "W1" }];
  assert.equal(lib.ownedPaper(paper, identities), undefined, "a different version must remain importable");
  assert.equal(lib.ownedPaper({ ...paper, version: 2 }, identities)?.documentId, "local");
  assert.equal(lib.ownedPaper({ ...paper, version: null }, identities), undefined, "unknown local version must not be claimed as a duplicate");
  assert.equal(lib.ownedPaper({ ...paper, arxivId: "" }, identities)?.documentId, "local", "OpenAlex-only links remain identifiable");
  const extracted = lib.readerAutomaticMetadata(document, { Author: "Wrong PDF producer", Title: "Wrong", CreationDate: "2011" }, "Inferred title", 7, ["title", "authors"]);
  assert.equal(extracted.authors, document.authors); assert.equal(extracted.title, document.title); assert.equal(extracted.year, document.year);
  assert.equal(extracted.filePath, document.filePath); assert.equal(extracted.pageCount, 7);
  const text = "arXiv:2401.01234v2 ".repeat(30);
  assert.equal(await lib.localPaperSeed(document, { pages: [{ documentId: "local", pageNumber: 1, text }] }), text, "cached first-page evidence must be reused without reopening PDF");
  for (const name of ["2609.36048v1.pdf", "arxiv-2609.36048v1.pdf", "arXiv_2609.36048v1 (2).PDF", "arXiv_2609.36048v1__2_.PDF"]) {
    assert.deepEqual(lib.arxivIdentityFromFileName(name), { id: "2609.36048", version: 1 });
    assert.equal(await lib.localPaperSeed({ ...document, fileName: name, title: "Incorrect saved title" }, { pages: [] }), "arXiv:2609.36048v1\n", "filename evidence must work on existing PDFs without page text or a correct title");
  }
  assert.deepEqual(lib.arxivIdentityFromFileName("hep-th_9901001v2.pdf"), { id: "hep-th/9901001", version: 2 });
  assert.deepEqual(lib.arxivIdentityFromFileName("2401.01234.pdf"), { id: "2401.01234", version: null });
  for (const name of ["my notes 2401.01234.pdf", "https://evil.test/2401.01234", "2401.01234v0.pdf", "ordinary-paper.pdf"]) assert.equal(lib.arxivIdentityFromFileName(name), null);
  await assert.rejects(() => lib.scholarlyInvoke("scholarly_search"), /macOS/, "browser preview must not silently issue external requests");
  console.log("Scholarly metadata, version identity and cached evidence checks passed.");
} finally { await rm(temporary, { recursive: true, force: true }); }
