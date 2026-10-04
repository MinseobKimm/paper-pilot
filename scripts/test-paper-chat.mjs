import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const require = createRequire(import.meta.url);
const temporary = await mkdtemp(path.join(tmpdir(), "paper-pilot-chat-"));
try {
  const compiled = path.join(temporary, "chat.mjs");
  await build({
    stdin: { contents: 'export * from "./src/lib/aiResults.ts"; export * from "./src/lib/aiPrompt.ts"; export { AssistantPanel } from "./src/components/panels/AssistantPanel.tsx";', resolveDir: process.cwd() },
    loader: { ".css": "empty" }, jsx: "automatic", bundle: true, platform: "node", format: "esm", outfile: compiled,
    plugins: [{ name: "external-runtime", setup(builder) {
      builder.onResolve({ filter: /^(pdfjs-dist|sbd|react|@tauri-apps)/ }, (args) => ({ path: require.resolve(args.path), external: true }));
    } }],
  });
  const lib = await import(pathToFileURL(compiled));
  const old = { id: "old", provider: "codex-cli", providerSessionId: "old-session", status: "complete" };
  const pending = { id: "pending", provider: "codex-cli", providerSessionId: "old-session", status: "pending" };
  assert.equal(lib.latestProviderSessionId([old], "codex-cli"), "old-session");
  const stored = JSON.stringify([old.id, pending.id]);
  const excluded = lib.paperChatExcludedResultIds(stored);
  assert.equal(lib.latestProviderSessionId([pending, old], "codex-cli", excluded), "", "reset must survive persisted state reload");
  assert.equal(lib.latestProviderSessionId([{ ...pending, status: "complete" }, old], "codex-cli", excluded), "", "late old results must not restore the previous conversation");
  const fresh = { ...old, id: "fresh", providerSessionId: "fresh-session" };
  assert.equal(lib.latestProviderSessionId([fresh, old], "codex-cli", excluded), "fresh-session");
  assert.equal(lib.latestProviderSessionId([{ ...fresh, status: "failed" }, old], "codex-cli", excluded), "");
  assert.equal(lib.latestProviderSessionId([fresh], "claude-code"), "", "sessions must stay provider-specific");
  assert.deepEqual(lib.paperChatExcludedResultIds("broken JSON"), []);
  const task = { taskType: "chatWithPaper", document: { id: "doc", title: "Paper", authors: "Author", fileName: "paper.pdf", filePath: "/papers/paper.pdf" }, payload: { question: "Explain the method", askMode: "auto", pages: [{ pageNumber: 1, text: "BODY MUST NOT BE INLINED" }], customPrompt: "Keep it concise" } };
  const prompt = lib.buildAiPrompt(task);
  assert.ok(prompt.includes("/papers/paper.pdf"));
  assert.ok(prompt.includes("Keep it concise"));
  assert.ok(prompt.includes("prioritize the paper"));
  assert.ok(!prompt.includes("BODY MUST NOT BE INLINED"));
  const payload = lib.bridgePayloadFor(task, prompt);
  assert.equal(payload.askMode, "deep", "all chat requests must use direct PDF execution");
  assert.equal(payload.pages, undefined);
  const props = { annotations: [], aiResults: [], settings: { aiProvider: "codex-cli" }, chatDraft: "Question", setChatDraft() {}, mode: "study", onNewChat: async () => {}, onQueueTask() {}, onHoverSource() {}, onGoToPage() {}, onCopy() {}, onDeleteExplanation() {}, onOpenExplanationResult() {} };
  const markup = renderToStaticMarkup(createElement(lib.AssistantPanel, props));
  assert.ok(!markup.includes('role="tablist"'), "mode selection must be removed");
  assert.ok(markup.includes("New chat") || markup.includes("새 대화"));
  const waiting = renderToStaticMarkup(createElement(lib.AssistantPanel, { ...props, aiResults: [{ ...old, taskType: "chatWithPaper", status: "pending", inputText: "Question", outputText: "", createdAt: "2026-10-04T00:00:00Z" }] }));
  assert.ok(waiting.includes('disabled=""'), "pending answers must disable overlapping conversations");
  console.log("Paper chat session and prompt checks passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
