import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
const require = createRequire(import.meta.url);
const temporary = await mkdtemp(path.join(tmpdir(), "paper-pilot-citations-"));
try {
  const compiled = path.join(temporary, "citations.mjs");
  await build({ stdin: { contents: 'export * from "./src/lib/paperCitations.ts"; export * from "./src/lib/aiPrompt.ts"; export * from "./src/lib/documentSettings.ts";', resolveDir: process.cwd() },
    loader: { ".css": "empty" }, jsx: "automatic", bundle: true, platform: "node", format: "esm", outfile: compiled,
    plugins: [{ name: "external-runtime", setup(builder) { builder.onResolve({ filter: /^(pdfjs-dist|sbd|react|@tauri-apps)/ }, (args) => ({ path: require.resolve(args.path), external: true })); } }],
  });
  const lib = await import(pathToFileURL(compiled));
  const pages = [{ pageNumber: 1, text: "Distillation (Hinton et al., 2015; Yang et al., 2026b). Hinton et al., 2015 supports this." },
    { pageNumber: 19, text: "References\nGeoffrey Hinton et al. Distilling the Knowledge in a Neural Network. 2015. arXiv:1503.02531.\nYang et al. A Different Paper. 2026b." }];
  const raw = "Geoffrey Hinton et al. Distilling the Knowledge in a Neural Network. 2015. arXiv:1503.02531.";
  const reference = { title: "Distilling the Knowledge in a Neural Network", authors: "Geoffrey Hinton et al.", year: "2015", arxivId: "1503.02531", rawReference: raw, citations: [{ page: 1, text: "Hinton et al., 2015" }] };
  const output = JSON.stringify({ references: [reference, { ...reference, title: "Invented paper" }, { ...reference, citations: [{ page: 1, text: "Nonexistent et al., 2030" }] },
    { title: "A Different Paper", authors: "Yang et al.", year: "2026b", rawReference: "Yang et al. A Different Paper. 2026b.", citations: [{ page: 1, text: "Yang et al., 2026b" }] }] });
  const references = lib.parsePaperCitationIndex(output, pages);
  assert.equal(references.length, 2, "invented titles and markers must not become clickable");
  assert.equal(references[0].arxivId, "1503.02531");
  assert.equal(references[1].year, "2026b", "year suffixes identify distinct works");
  assert.equal(lib.parsePaperCitationIndex(JSON.stringify({ references: [{ ...reference, arxivId: "9999.99999" }] }), pages)[0].arxivId, "", "model-invented IDs must not be queried");
  assert.throws(() => lib.parsePaperCitationIndex('{"references":[{"title":"Fabricated"}]}', pages));
  assert.deepEqual(lib.parsePaperCitationIndex('{"references":[]}', pages), []);
  const completed = { documentId: "doc", taskType: "indexPaperCitations", inputText: `[citation index v${lib.citationIndexVersion}]`, createdAt: new Date().toISOString(), status: "complete" };
  assert.equal(lib.hasBlockingCitationIndexTask([completed], "doc"), true, "reopening before cache persistence must consume the finished task, not queue Codex again");
  assert.equal(lib.hasBlockingCitationIndexTask([{ ...completed, status: "pending" }], "doc"), true);
  assert.equal(lib.hasBlockingCitationIndexTask([{ ...completed, status: "failed" }], "doc"), false);
  assert.equal(lib.hasBlockingCitationIndexTask([{ ...completed, status: "pending", createdAt: "2020-01-01T00:00:00Z" }], "doc"), false);
  assert.equal(lib.hasBlockingCitationIndexTask([completed], "different-doc"), false);

  const text = "Hinton et al.,\n2015; Yang et al., 2026b";
  const boxes = [{ start: 0, end: 13, rect: { left: 10, top: 20, width: 130, height: 14 } },
    { start: 14, end: text.length, rect: { left: 10, top: 40, width: 240, height: 14 } }];
  const hits = lib.paperCitationTargets(1, text, boxes, references);
  assert.equal(hits.length, 3, "wrapped citations need separate hit areas on each line");
  assert.ok(hits.every((hit) => hit.rect.height === 14), "a wrapped marker must not create a giant rectangle covering unrelated text");
  assert.equal(hits.filter((hit) => hit.referenceId === references[1].id).length, 1, "semicolon-separated references stay independent");
  assert.deepEqual(lib.paperCitationTargets(2, text, boxes, references), [], "links must stay on their source page");
  const twice = lib.paperCitationTargets(1, pages[0].text, [{ start: 0, end: pages[0].text.length, rect: { left: 0, top: 0, width: 1000, height: 14 } }], [references[0]]);
  assert.equal(twice.length, 2, "every occurrence of a citation must be clickable");

  const exactPaper = { arxivId: "1503.02531", title: reference.title };
  assert.deepEqual(lib.rankCitationPapers(reference.title, [{ arxivId: "wrong", title: "Unrelated network paper" }, exactPaper]), [exactPaper], "unrelated arXiv search results must be filtered out");
  const settings = { [lib.citationIndexKey("doc")]: JSON.stringify({ version: lib.citationIndexVersion, resultId: "result", references }) };
  assert.equal(lib.citationIndexFromSettings(settings, "doc").references.length, 2);
  lib.deleteDocumentScopedSettings(settings, ["doc"]);
  assert.equal(lib.citationIndexFromSettings(settings, "doc"), null, "deleting a PDF must delete its citation cache");

  const task = { taskType: "indexPaperCitations", document: { id: "doc", title: "Paper", authors: "Author", year: "2026", fileName: "source.pdf", filePath: "/papers/source.pdf" }, payload: { pages: Array.from({ length: 24 }, (_, index) => ({ pageNumber: index + 1, text: index === 23 ? "BIBLIOGRAPHY ON LAST PAGE" : "Body text" })), customPrompt: "SEARCH THE INTERNET" } };
  const prompt = lib.buildAiPrompt(task);
  assert.ok(prompt.includes("Do not browse, search the internet"));
  assert.ok(prompt.includes("BIBLIOGRAPHY ON LAST PAGE"), "references beyond page 16 must reach Codex");
  assert.ok(!prompt.includes("SEARCH THE INTERNET"), "custom instructions must not override the no-search task");
  assert.equal(lib.bridgePayloadFor(task, prompt).pages.length, 24);
  const hookOutput = path.join(temporary, "citation-hook.mjs");
  const hookRuntime = `
    let cursor = 0; const slots = []; const pending = [];
    export function beginRender() { cursor = 0; pending.length = 0; }
    export function reset() { slots.length = 0; beginRender(); }
    export function useRef(value) { const i = cursor++; return slots[i] ??= { current: value }; }
    export function useState(value) { const i = cursor++; slots[i] ??= value; return [slots[i], (next) => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; }
    export function useEffect(effect) { pending.push(effect); }
    export async function flushEffects() { for (const effect of pending.splice(0)) effect(); for (let i = 0; i < 12; i++) await Promise.resolve(); }
  `;
  await build({ stdin: { contents: 'export * from "./src/hooks/usePaperCitations.ts"; export * from "citation-hook-runtime";', resolveDir: process.cwd() },
    bundle: true, platform: "node", format: "esm", outfile: hookOutput, plugins: [{ name: "hook-runtime", setup(builder) {
      builder.onResolve({ filter: /^(react|citation-hook-runtime)$/ }, () => ({ path: "hooks", namespace: "test" }));
      builder.onResolve({ filter: /\/tauri$/ }, () => ({ path: "tauri", namespace: "test" }));
      builder.onResolve({ filter: /\/scholarlyService$/ }, () => ({ path: "scholarly", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, ({ path }) => ({ contents: path === "hooks" ? hookRuntime : path === "tauri" ? 'export const isTauriRuntime = () => false; export async function setSetting() {}' : 'export const scholarlyRequestId = () => "test"; export async function scholarlyInvoke() { throw new Error("API should not run in this test"); }' }));
    } }] });
  const hook = await import(pathToFileURL(hookOutput));
  const existing = { id: "doc", title: "Already imported PDF", pageCount: 2 };
  const existingPages = pages.map((page) => ({ ...page, documentId: existing.id }));
  let queueCalls = 0;
  const input = { state: { documents: [existing], settings: {}, pages: [], aiResults: [{ ...completed, id: "saved-result", outputText: JSON.stringify({ references: [reference] }) }] },
    activeDocument: existing, pdfDocument: { numPages: 2 }, activePages: [],
    ensureActivePages: async () => existingPages, queueTask: async () => { queueCalls++; return { id: "new" }; },
    patchState: (mutate) => mutate(input.state) };
  hook.beginRender(); hook.usePaperCitations(input); await hook.flushEffects();
  assert.equal(input.state.settings[lib.citationIndexKey("doc")], undefined, "saved results must wait for reopened PDF page text");
  input.state.pages = existingPages; input.activePages = existingPages;
  hook.beginRender(); hook.usePaperCitations(input); await hook.flushEffects();
  assert.equal(lib.citationIndexFromSettings(input.state.settings, "doc").references.length, 1, "reopened PDFs must restore completed connections after page extraction");
  assert.equal(queueCalls, 0, "restoring an existing index must not run Codex again");
  hook.reset(); input.state.settings = {}; input.state.aiResults = []; input.state.pages = []; input.activePages = [];
  hook.beginRender(); hook.usePaperCitations(input); await hook.flushEffects();
  assert.equal(queueCalls, 1, "already imported PDFs without an index must queue initial citation work when opened");
  console.log("Citation extraction, wrapped hit areas, cache, arXiv ranking and no-search prompt checks passed.");
} finally { await rm(temporary, { recursive: true, force: true }); }
