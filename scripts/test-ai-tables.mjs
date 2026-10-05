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
const temporary = await mkdtemp(path.join(tmpdir(), "paper-pilot-tables-"));
try {
  const compiled = path.join(temporary, "tables.mjs");
  await build({ entryPoints: ["src/components/FormattedAiText.tsx"], loader: { ".css": "empty" }, jsx: "automatic", bundle: true, platform: "node", format: "esm", outfile: compiled,
    plugins: [{ name: "react-runtime", setup(builder) { builder.onResolve({ filter: /^react(?:\/|$)/ }, (args) => ({ path: require.resolve(args.path), external: true })); } }],
  });
  const { FormattedAiText } = await import(pathToFileURL(compiled));
  const render = (text) => renderToStaticMarkup(createElement(FormattedAiText, { text, onPageCitation() {} }));
  const screenshot = render("| 구분 | 다음 토큰을 예측할 때 주어지는 문맥 |\n\n|---|---|\n\n| 기존 증류 학습 | 질문 + **교사가 생성한** 답변 앞부분 |\n\n| 실제 학생의 답변 생성 | 질문 + **학생 자신이 생성한** 답변 앞부분 |");
  assert.equal((screenshot.match(/<table /g) || []).length, 1);
  assert.equal((screenshot.match(/<th /g) || []).length, 2);
  assert.equal((screenshot.match(/<td /g) || []).length, 4);
  assert.ok(screenshot.includes("<strong>교사가 생성한</strong>"));
  assert.ok(!screenshot.includes("|---|"));
  const mixed = render("Before\n\nName | Value\n:--- | ---:\nA\\|B | $|x|$ (p. 12)\nC | 2\n\nAfter");
  assert.ok(mixed.includes("A|B"));
  assert.ok(mixed.includes('text-align:right'));
  assert.ok(mixed.includes('class="katex"'));
  assert.ok(mixed.includes('class="page-citation-link"'));
  assert.ok(mixed.includes("Before") && mixed.includes("After"));
  assert.ok(!render("a | b\n--- | invalid\nc | d").includes("<table"), "malformed tables must remain readable text");
  assert.ok(render("| Header | Value |\n|---|---|\n| <script>alert(1)</script> | x |").includes("&lt;script&gt;"));
  const adjacent = render("|A|B|\n|---|---|\n|1|2|\n\nParagraph\n\n|C|D|\n|---|---|\n|3|4|");
  assert.equal((adjacent.match(/<table /g) || []).length, 2);
  console.log("AI table rendering checks passed: screenshot, alignment, math, citations, escaping, and surrounding text.");
} finally { await rm(temporary, { recursive: true, force: true }); }
