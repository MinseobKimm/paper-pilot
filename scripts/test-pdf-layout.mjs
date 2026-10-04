import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const temporary = await mkdtemp(path.join(tmpdir(), "paper-pilot-layout-"));
try {
  const compiled = path.join(temporary, "layout.mjs");
  await build({
    stdin: { contents: 'export * from "./src/lib/pdfText.ts"; export * from "./src/lib/translations.ts";', resolveDir: process.cwd() },
    bundle: true, platform: "node", format: "esm", outfile: compiled,
    plugins: [{ name: "native-pdfjs", setup(builder) {
      builder.onResolve({ filter: /^(pdfjs-dist|sbd|react)/ }, (args) => ({ path: require.resolve(args.path), external: true }));
    } }],
  });
  const lib = await import(pathToFileURL(compiled));
  const box = (text, x, y, width, font = 10) => ({ text, start: 0, end: 0, rect: { left: x, top: y, width, height: font * 1.2 }, fontSize: font, fontName: "body" });
  const paragraph = (prefix, x, y, width, count = 5) => Array.from({ length: count }, (_, i) => box(`${prefix}${i} This is a complete paragraph sentence.`, x, y + i * 14, width));
  const order = (boxes) => lib.textLinesFromBoxes(boxes).map((line) => line.text);
  const left = paragraph("Left", 30, 80, 200), right = paragraph("Right", 255, 83, 220);
  assert.deepEqual(order([...left, ...right]), [...left, ...right].map((item) => item.text), "staggered columns must not interleave");
  const numbered = [...left, box("(1)", 230, 150, 12), ...right, box("note", 255, 150, 18), box("the definition in this column.", 276, 150, 190)];
  const numberedText = order(numbered).join(" ");
  assert.ok(numberedText.indexOf("(1)") < numberedText.indexOf("Right0"), "short equation numbers must not join the next column");
  const title = box("A full-width title", 60, 10, 380, 18);
  const author = box("Centered authors", 175, 40, 180);
  assert.deepEqual(order([title, author, ...left, ...right]), [title, author, ...left, ...right].map((item) => item.text));
  const middle = paragraph("Full", 30, 165, 445, 3);
  const lowerLeft = paragraph("LowerLeft", 30, 225, 200), lowerRight = paragraph("LowerRight", 255, 225, 220);
  const mixed = [...left, ...right, ...middle, ...lowerLeft, ...lowerRight];
  assert.deepEqual(order(mixed), mixed.map((item) => item.text), "two -> one -> two columns on one page");
  const three = [...paragraph("A", 20, 30, 130), ...paragraph("B", 165, 30, 130), ...paragraph("C", 310, 30, 130)];
  assert.deepEqual(order(three), three.map((item) => item.text), "three columns");
  const single = paragraph("Single", 30, 30, 445);
  assert.deepEqual(order(single), single.map((item) => item.text), "single-column reports");
  const table = Array.from({ length: 5 }, (_, row) => [box(`Item ${row}`, 30, 30 + row * 16, 70), box(`${row * 10}`, 250, 30 + row * 16, 30)]).flat();
  assert.deepEqual(order(table), table.map((item) => item.text), "numeric tables stay row-wise");
  const slide = [box("Slide title", 30, 10, 160, 25), box("First bullet", 30, 70, 220, 18), box("Second bullet", 30, 140, 250, 18)];
  assert.deepEqual(order(slide), slide.map((item) => item.text));
  const cjk = [...paragraph("가나다라마바사아자차카타파하", 30, 30, 180), ...paragraph("한글문단의읽기순서를확인합니다", 250, 30, 210)];
  assert.deepEqual(order(cjk), cjk.map((item) => item.text));
  assert.deepEqual(order([]), [], "image-only page has no fabricated text");
  for (const scale of [0.6, 1.95, 3]) {
    const scaled = mixed.map((item) => ({ ...item, fontSize: item.fontSize * scale,
      rect: Object.fromEntries(Object.entries(item.rect).map(([key, value]) => [key, value * scale])) }));
    assert.deepEqual(order(scaled), order(mixed), `zoom-independent order at ${scale}`);
  }
  const indexed = lib.textAndBoxesFromOrderedLines(lib.textLinesFromBoxes(mixed));
  for (const item of indexed.boxes) assert.equal(indexed.text.slice(item.start, item.end), item.text, "highlight offsets must refer to the same text");
  const spans = indexed.boxes.map((item) => ({
    dataset: { flowId: String(item.flowId) }, textContent: item.text,
    getBoundingClientRect: () => ({ ...item.rect, right: item.rect.left + item.rect.width, bottom: item.rect.top + item.rect.height }),
  }));
  for (const [startY, endY] of [[85, 127], [127, 85]]) {
    const selected = lib.selectedSpansFromGesture({}, spans, { startX: 100, startY, endX: 100, endY });
    assert.equal(selected.length, 4, "forward and backward drags select four lines");
    assert.ok(selected.every(({ span }) => span.textContent.startsWith("Left")), "a drag within a column must not include its neighbor");
  }
  const page = { documentId: "test", pageNumber: 1, text: "Left paragraph. Right paragraph.", outlineLabel: "" };
  const result = { documentId: "test", taskType: "translatePage", status: "complete", inputText: "[translation: Korean; page 1]\nLeft Right paragraph. paragraph.", outputText: "" };
  assert.equal(lib.translationResultsForPage([result], page, "Korean").length, 0, "do not reuse translation after layout correction");
  result.inputText = "[translation: Korean; page 1]\n" + page.text;
  assert.equal(lib.translationResultsForPage([result], page, "Korean").length, 1, "keep translations for unchanged source");
  page.text = "Left paragraph.\n\nRight paragraph.";
  assert.equal(lib.translationResultsForPage([result], page, "Korean").length, 0, "changed regions invalidate positional sentence IDs");
  console.log("Passed layout regressions: columns, mixed regions, reports, slides, tables, CJK, zoom, offsets, translation cache.");

  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  for (const file of process.argv.slice(2)) {
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await readFile(file)), standardFontDataUrl: path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts/") }).promise;
    const modes = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number), content = await page.getTextContent();
      let reference;
      for (const scale of [1, 1.95]) {
        const viewport = page.getViewport({ scale });
        const output = lib.textBoxesFromPdfItems(content.items, viewport, scale);
        if (reference !== undefined) assert.equal(output.text, reference, `text must not change with zoom: ${path.basename(file)} p${number}`);
        reference = output.text;
        const raw = lib.pdfItemTextBoxes(content.items, viewport, scale);
        assert.equal(output.boxes.length, raw.length, `every text box retained: p${number}`);
      }
      modes.push(lib.inferPageTextLayoutFromPdfItems(content.items, page.getViewport({ scale: 1 }), 1).mode);
      if (number === 1 && reference.includes("Entropy-Aware On-Policy")) {
        assert.ok(reference.indexOf("Nathalie") < reference.indexOf("Abstract"));
        assert.ok(reference.indexOf("Our code") < reference.indexOf("1. Introduction"));
        assert.ok(reference.indexOf("The standard") < reference.indexOf("Knowledge distillation"));
      }
      if (number === 2 && reference.includes("Entropy-Aware On-Policy")) {
        assert.ok(reference.indexOf("Forward KL (Teacher-to-Student)") < reference.indexOf("2.2. On-Policy"), "equation labels must not interrupt column order");
      }
    }
    console.log(`${path.basename(file)}: ${pdf.numPages} pages checked; layouts: ${modes.join(", ")}`);
    await pdf.destroy();
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
