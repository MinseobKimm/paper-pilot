import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const temporary = await mkdtemp(path.join(tmpdir(), "paper-pilot-word-meanings-"));
try {
  const compiled = path.join(temporary, "word-meanings.mjs");
  await build({ entryPoints: ["src/lib/wordMeanings.ts"], bundle: true, platform: "node", format: "esm", outfile: compiled });
  const { hasWordMeaningForContext } = await import(pathToFileURL(compiled));
  const sentence = "The method uses extrapolation in output space.";
  const entry = { id: "wm", word: "extrapolation", meaning: "외삽", documentId: "paper-a", documentTitle: "Paper A", context: sentence, createdAt: "2026-10-07", source: "local-llm" };
  assert.equal(hasWordMeaningForContext([], "paper-a", sentence), false, "first lookup must translate");
  assert.equal(hasWordMeaningForContext([entry], "paper-a", sentence), true, "a repeated request in the same context can explain");
  assert.equal(hasWordMeaningForContext([entry], "paper-a", "Extrapolation predicts unseen values."), false, "a new sentence must translate first");
  assert.equal(hasWordMeaningForContext([entry], "paper-b", sentence), false, "another paper must not enable explanation");
  assert.equal(hasWordMeaningForContext([{ ...entry, meaning: " " }], "paper-a", sentence), false, "an empty meaning cannot enable explanation");
  assert.equal(hasWordMeaningForContext([{ ...entry, context: sentence.replaceAll(" ", "\n") }], "paper-a", ` ${sentence} `), true, "PDF line wrapping must not hide a saved context");
  console.log("Word meaning context checks passed (6 cases).");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
