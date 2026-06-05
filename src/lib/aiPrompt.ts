import type { AiProviderKind, AiTaskType, DocumentContextPack, PageRecord } from "../types";
import type { AiTask } from "./ai";

export function localSummary(pages: PageRecord[], detailed = false): string {
  const body = pages
    .map((page) => page.text)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  if (!body) {
    return "No extractable text is available yet.";
  }
  const sentences = body.match(/[^.!?]+[.!?]+/g) ?? [body];
  const limit = detailed ? 8 : 3;
  return sentences.slice(0, limit).map((item) => item.trim()).join("\n");
}

export function providerLabel(provider: AiProviderKind): string {
  if (provider === "claude-code") {
    return "Claude Code";
  }
  if (provider === "local-draft") {
    return "Local draft";
  }
  return "Codex CLI";
}

export function inputTextFor(payload: Record<string, unknown>): string {
  if (Array.isArray(payload.words)) {
    const words = payload.words.filter((word): word is string => typeof word === "string" && word.trim().length > 0);
    const context = typeof payload.context === "string" && payload.context.trim() ? `\nContext: ${payload.context.trim()}` : "";
    return `[word meanings: ${words.slice(0, 160).join(", ")}]${context}`;
  }
  if (typeof payload.mode === "string" && Array.isArray(payload.pages)) {
    return `[summary: ${payload.mode}, ${payload.pages.length} extracted page(s)]`;
  }
  if (typeof payload.imageDataUrl === "string") {
    const page = typeof payload.page === "number" ? `page ${payload.page}` : "selected region";
    return `[image crop: ${page}]`;
  }
  if (typeof payload.text === "string" && typeof payload.translationLanguageName === "string") {
    return `[translation: ${payload.translationLanguageName}]\n${payload.text}`;
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }
  if (typeof payload.question === "string") {
    return payload.question;
  }
  if (typeof payload.reference === "string") {
    return payload.reference;
  }
  if (typeof payload.page === "number" && Array.isArray(payload.pages)) {
    return `[page ${payload.page} extracted page(s)]`;
  }
  if (Array.isArray(payload.pages)) {
    return `[${payload.pages.length} extracted page(s)]`;
  }
  return JSON.stringify(payload);
}

function pagesFromPayload(payload: Record<string, unknown>): PageRecord[] {
  return Array.isArray(payload.pages) ? (payload.pages as PageRecord[]) : [];
}

const translationLanguageNames: Record<string, string> = {
  ko: "Korean",
  en: "English",
  ja: "Japanese",
  "zh-Hans": "Simplified Chinese",
  "zh-Hant": "Traditional Chinese",
  ru: "Russian",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  vi: "Vietnamese",
  th: "Thai",
  id: "Indonesian",
  ar: "Arabic",
};

const outlineJsonInstruction =
  'Extract the document outline from the whole PDF text. The extracted text is supplied in reading order; for two-column papers it is left column top-to-bottom first, then right column top-to-bottom. Return ONLY JSON with this exact shape: {"outline":[{"number":"1.1","title":"1.1 Related Works","page":3,"level":1,"anchorText":"1.1 Related Works"}]}. Include only headings that explicitly start with numeric section labels such as 1, 1.1, 1.1.1, followed by a real heading title that starts with a word/letter. Exclude numeric table rows, metric cells, values like 6.0(1.2) 47.4(5.3), Abstract, References, appendix labels without a numeric section number, captions, equations, body sentences, citations, speaker labels such as user/assistant/system, and invented summaries. Keep title text exactly as it appears in the PDF, in English if the PDF is English. Page must be the page where that heading begins. Sort by numeric section order.';

function translationLanguageNameFromPayload(payload: Record<string, unknown>) {
  if (typeof payload.translationLanguageName === "string" && payload.translationLanguageName.trim()) {
    return compactText(payload.translationLanguageName, 80);
  }
  if (typeof payload.translationLanguage === "string") {
    return translationLanguageNames[payload.translationLanguage] ?? "Korean";
  }
  return "Korean";
}

function sanitizeText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[\ud800-\udfff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value: string, limit = 9000): string {
  const text = sanitizeText(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function documentContextPackFromPayload(payload: Record<string, unknown>): DocumentContextPack | null {
  const value = payload.documentContextPack;
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const pages = Array.isArray(record.pages)
    ? record.pages
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const page = item as Record<string, unknown>;
          const pageNumber = typeof page.pageNumber === "number" ? page.pageNumber : null;
          if (!pageNumber) {
            return null;
          }
          return {
            pageNumber,
            outlineLabel: typeof page.outlineLabel === "string" ? compactText(page.outlineLabel, 220) : "",
            detectedTitle: typeof page.detectedTitle === "string" ? compactText(page.detectedTitle, 220) : "",
            charCount: typeof page.charCount === "number" ? page.charCount : 0,
            start: typeof page.start === "string" ? compactText(page.start, 260) : "",
            end: typeof page.end === "string" ? compactText(page.end, 220) : "",
            hasText: page.hasText === true,
          };
        })
        .filter((item): item is DocumentContextPack["pages"][number] => item !== null)
    : [];
  const outline = Array.isArray(record.outline)
    ? record.outline
        .map((item) => {
          if (!item || typeof item !== "object") {
            return null;
          }
          const row = item as Record<string, unknown>;
          const pageNumber = typeof row.pageNumber === "number" ? row.pageNumber : null;
          const title = typeof row.title === "string" ? compactText(row.title, 180) : "";
          if (!pageNumber || !title) {
            return null;
          }
          return {
            pageNumber,
            title,
            level: typeof row.level === "number" ? Math.max(0, Math.min(3, Math.round(row.level))) : 0,
            source: typeof row.source === "string" ? compactText(row.source, 40) : "",
          };
        })
        .filter((item): item is DocumentContextPack["outline"][number] => item !== null)
    : [];
  return {
    documentId: typeof record.documentId === "string" ? record.documentId : "",
    title: typeof record.title === "string" ? compactText(record.title, 500) : "",
    pageCount: typeof record.pageCount === "number" ? record.pageCount : pages.length,
    extractedPageCount: typeof record.extractedPageCount === "number" ? record.extractedPageCount : pages.length,
    totalTextChars: typeof record.totalTextChars === "number" ? record.totalTextChars : 0,
    outline: outline.slice(0, 140),
    pages,
  };
}

function formatDocumentContextPackForPrompt(pack: DocumentContextPack): string {
  const outlineText = pack.outline.length
    ? pack.outline
        .map((row) => `${"  ".repeat(Math.max(0, row.level))}- p.${row.pageNumber} ${row.title}`)
        .join("\n")
    : "(no PDF/AI outline available)";
  const pageText = pack.pages
    .map((page) =>
      [
        `p.${page.pageNumber} chars=${page.charCount}${page.hasText ? "" : " no-extracted-text"}`,
        page.detectedTitle ? `title=${page.detectedTitle}` : "",
        page.outlineLabel ? `label=${page.outlineLabel}` : "",
        page.start ? `start=${compactText(page.start, 260)}` : "",
        page.end && page.end !== page.start ? `end=${compactText(page.end, 220)}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .join("\n");
  return [
    "Document Context Pack",
    `Title: ${pack.title || "(untitled)"}`,
    `Pages: ${pack.pageCount}; extracted pages: ${pack.extractedPageCount}; extracted chars: ${pack.totalTextChars}`,
    `Outline:\n${outlineText}`,
    `Page capsules:\n${pageText || "(none)"}`,
  ].join("\n");
}

function splitSentences(text: string): string[] {
  return compactText(text, 20000).match(/[^.!?]+[.!?]+/g)?.map((item) => item.trim()) ?? [];
}

function keywords(text: string): string[] {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "are",
    "was",
    "were",
    "can",
    "has",
    "have",
    "using",
    "paper",
    "study",
  ]);
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) {
    if (!stop.has(word)) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);
}

function relevantSentences(question: string, pages: PageRecord[]) {
  const terms = new Set(keywords(question));
  const sentences = splitSentences(pages.map((page) => page.text).join(" "));
  const ranked = sentences
    .map((sentence) => ({
      sentence,
      score: keywords(sentence).filter((word) => terms.has(word)).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => item.sentence);
  return ranked.length ? ranked : sentences.slice(0, 5);
}

export function buildAiPrompt(task: AiTask): string {
  const pages = pagesFromPayload(task.payload);
  const documentContextPack = documentContextPackFromPayload(task.payload);
  const isFullPaperChat = task.taskType === "chatWithPaper";
  const pageTextLimit =
    task.taskType === "translatePage"
      ? 3600
      : task.taskType === "chatWithPaper" || task.taskType === "explainRegionImage"
        ? 2800
        : task.taskType === "outlineDocument"
          ? 220000
          : task.taskType === "classifyDocumentLayout"
            ? 18000
          : task.taskType === "defineWordMeanings"
            ? 22000
          : task.taskType === "summarizePaper"
            ? 5200
            : 6500;
  const pageText = isFullPaperChat
    ? ""
    : compactText(
        pages
          .map((page) => {
            const limit =
              task.taskType === "outlineDocument"
                ? pages.length > 160
                  ? 2200
                  : pages.length > 80
                    ? 4200
                    : 9000
                : task.taskType === "classifyDocumentLayout"
                  ? 1800
                : task.taskType === "defineWordMeanings"
                  ? 1400
                : task.taskType === "summarizePaper"
                  ? 520
                  : 760;
            const source =
              task.taskType === "outlineDocument"
                ? page.text
                : page.outlineLabel || page.text;
            return `Page ${page.pageNumber}${task.taskType === "outlineDocument" ? " (left column first, then right column if two-column)" : ""}: ${compactText(source, limit)}`;
          })
          .join("\n\n"),
        pageTextLimit,
      );
  const text = typeof task.payload.text === "string" ? compactText(task.payload.text, 8000) : "";
  const sentenceRows = Array.isArray(task.payload.sentences)
    ? (task.payload.sentences as Array<{ id?: string; source?: string }>)
        .map((item, index) => ({
          id: item.id || `s${index}`,
          source: compactText(item.source || "", 1000),
        }))
        .filter((item) => item.source)
    : [];
  const sentenceText = sentenceRows.length
    ? sentenceRows.map((item) => `${item.id}: ${item.source}`).join("\n")
    : "";
  const question = typeof task.payload.question === "string" ? compactText(task.payload.question, 3000) : "";
  const reference = typeof task.payload.reference === "string" ? compactText(task.payload.reference, 5000) : "";
  const url = typeof task.payload.url === "string" ? compactText(task.payload.url, 1000) : "";
  const wordMeaningWords = Array.isArray(task.payload.words)
    ? task.payload.words
        .filter((word): word is string => typeof word === "string" && word.trim().length > 0)
        .map((word) => compactText(word, 80))
        .slice(0, 160)
    : [];
  const wordMeaningContext = typeof task.payload.context === "string" ? compactText(task.payload.context, 1600) : "";
  const candidateTermText = Array.isArray(task.payload.candidateTerms)
    ? task.payload.candidateTerms
        .map((item) => {
          if (!item || typeof item !== "object") {
            return "";
          }
          const record = item as Record<string, unknown>;
          const term = typeof record.term === "string" ? compactText(record.term, 100) : "";
          const kind = typeof record.kind === "string" ? compactText(record.kind, 20) : "";
          const count = typeof record.count === "number" ? record.count : "";
          const reason = typeof record.reason === "string" ? compactText(record.reason, 160) : "";
          return term ? `- ${term}${kind ? ` (${kind}` : ""}${count !== "" ? `, freq=${count}` : ""}${kind ? ")" : ""}${reason ? `: ${reason}` : ""}` : "";
        })
        .filter(Boolean)
        .join("\n")
    : "";
  const layoutCandidateText = Array.isArray(task.payload.layoutCandidates)
    ? task.payload.layoutCandidates
        .map((item) => {
          if (!item || typeof item !== "object") {
            return "";
          }
          const record = item as Record<string, unknown>;
          const page = typeof record.page === "number" ? record.page : typeof record.pageNumber === "number" ? record.pageNumber : "";
          const mode = typeof record.mode === "string" ? record.mode : "";
          const confidence = typeof record.confidence === "number" ? record.confidence.toFixed(2) : "";
          const reason = typeof record.reason === "string" ? compactText(record.reason, 260) : "";
          return page ? `- page ${page}: local=${mode || "unknown"}${confidence ? ` confidence=${confidence}` : ""}${reason ? ` (${reason})` : ""}` : "";
        })
        .filter(Boolean)
        .join("\n")
    : "";
  const existingMeaningText = Array.isArray(task.payload.existingMeanings)
    ? task.payload.existingMeanings
        .map((item, index) => {
          if (!item || typeof item !== "object") {
            return "";
          }
          const record = item as Record<string, unknown>;
          const meaning = typeof record.meaning === "string" ? compactText(record.meaning, 260) : "";
          const context = typeof record.context === "string" ? compactText(record.context, 260) : "";
          const title = typeof record.documentTitle === "string" ? compactText(record.documentTitle, 160) : "";
          return meaning ? `${index + 1}. ${meaning}${title ? ` (${title})` : ""}${context ? ` - ${context}` : ""}` : "";
        })
        .filter(Boolean)
        .join("\n")
    : "";
  const customPrompt = typeof task.payload.customPrompt === "string" ? compactText(task.payload.customPrompt, 2000) : "";
  const targetLanguage = translationLanguageNameFromPayload(task.payload);
  const conceptTermGlossInstruction =
    "When the output language is Korean, render important paper concept terms as the exact English term immediately followed by a concise Korean gloss in parentheses, e.g. attention mechanism(주의 메커니즘). Apply this to method names, task names, metrics, named components, and field-specific technical keywords when a Korean gloss helps; keep dataset names, model names, and acronyms English-only if a gloss would be awkward or misleading.";
  const promptDocumentLine = `Document: ${task.document.title || "Untitled"}${task.document.authors ? ` / Authors: ${task.document.authors}` : ""}${
    task.document.year ? ` / Year: ${task.document.year}` : ""
  }`;
  const documentContextText = documentContextPack ? formatDocumentContextPackForPrompt(documentContextPack) : "";
  const fullPaperPdfPath = isFullPaperChat ? compactText(task.document.filePath, 1200) : "";
  const chatEvidenceInstruction =
    task.taskType === "chatWithPaper"
      ? [
          "Full-paper mode is enabled.",
          "Use the PDF file path below as the primary source and inspect the entire paper when the question requires cross-page synthesis.",
          "Use the Document Context Pack only as a navigation aid for page counts and page capsules; do not treat it as a selected-excerpt evidence set.",
          "Do not rely on local lexical retrieval, selected excerpts, model memory, or the document title alone.",
          "If a shell command is blocked, try another available local tool or parser before giving up.",
          "If the PDF cannot be read directly, say that clearly and then answer only from any provided extracted page capsules.",
          "Cite factual claims with page markers in one consistent format: (p. 12). Use the PDF page numbers from the paper, not internal tool offsets or chunk indexes.",
          "If a page number cannot be verified, do not invent it; state that the page could not be verified.",
        ].join(" ")
      : "";
  const translationPairInstruction =
    task.taskType === "translatePage"
      ? `Translate the full source text into natural ${targetLanguage}, but keep alignment exact. Use the provided sentence IDs as the only alignment source. Return one JSON item per translated sentence ID; do not group multiple IDs into one item. For each item, sourceIds must contain exactly one provided ID, and source must be copied exactly from that ID source text. Do not invent, renumber, reorder, or omit source IDs for translated prose. The translation field must be written in ${targetLanguage}. ${conceptTermGlossInstruction} Translate the surrounding sentence naturally into ${targetLanguage}. Include prose captions, legends, and descriptions attached to figures, photos, graphs, charts, or tables when they explain the visual. Skip only table/chart/graph internals such as cell values, axis labels, tick labels, legend keys without prose, numeric-only fragments, headers/footers, references, and PDF extraction noise unless they are essential prose. Output only valid JSON: {"pairs":[{"sourceIds":["p1-s0"],"source":"exact original sentence for p1-s0","translation":"${targetLanguage} translation"}]}. Keep equations and LaTeX readable in Markdown LaTeX. Do not add explanations or Markdown fences.`
      : "";
  const taskInstruction: Record<string, string> = {
    explainText:
      "Explain the selected passage in Korean in the context of the paper. Clarify required background, notation, formulas, and technical terms without inventing content.",
    explainRegionImage:
      "Inspect the attached image region first. Explain visible figures, tables, formulas, or text in Korean using the surrounding paper context. If the image is unclear, rely only on the provided extracted text as supporting evidence.",
    translateText:
      `Translate the selected text into natural ${targetLanguage}. Keep model names, method names, datasets, benchmarks, metrics, acronyms, named components, and field-specific technical terms in English when that is clearer.`,
    translatePage: sentenceRows.length
      ? `Translate the page into natural ${targetLanguage} using the provided sentence IDs. Return valid JSON only: {"pairs":[{"sourceIds":["p1-s0"],"source":"exact original sentence","translation":"translated sentence"}]}. Each output item must correspond to exactly one provided sentence ID, and source must copy that original sentence exactly. ${conceptTermGlossInstruction} Keep LaTeX readable.`
      : `Translate the page text into natural ${targetLanguage}. Preserve paragraph structure and keep core technical names in English when appropriate.`,
    summarizePaper:
      task.payload.mode === "detailed"
        ? "Summarize the paper in Korean with at most five concise bullets covering background, problem, method, results, and limitations."
        : "Summarize the core contribution of the paper in exactly three concise Korean lines, each starting with '- '.",
    chatWithPaper:
      "Answer the user's question in Korean using only the provided PDF evidence. Cite page numbers like (p. 12). If the evidence is insufficient, say what pages were checked and what is missing.",
    autoHighlight:
      'Select important claim, method, result, or limitation sentences from the current page. Return valid JSON only: {"highlights":[{"page":1,"text":"exact original sentence","tag":"Methods","reason":"short Korean reason"}]}. The text field must be copied from the PDF exactly.',
    citationReason:
      "Explain in Korean why this reference is cited or how it may be relevant to the current paper. Stay specific and evidence-based.",
    externalLinkSummary:
      "Summarize the provided link or reference information in Korean. If the link cannot be accessed, use only the provided metadata and say so.",
    outlineDocument:
      "Extract the numeric section outline from the paper. The page text is already ordered left column top-to-bottom, then right column top-to-bottom for two-column PDFs. Include only headings that explicitly start with numeric labels such as 1, 1.1, or 1.1.1 and whose title begins with a word/letter after the number. Do not include table numeric rows, body sentences, equations, captions, citations, References, or speaker labels such as user/assistant/system.",
    classifyDocumentLayout:
      'Classify each requested page layout for text selection. Use local geometry signals when provided, and use extracted text only as supporting context. Return valid JSON only: {"pages":[{"page":1,"layout":"single"|"two-column","reason":"short evidence"}],"layout":"single"|"two-column"}. "layout" is the majority body layout across the requested pages.',
    recommendPapers:
      "Recommend related papers or research directions in Korean based on the current document topic, with short reasons.",
    defineWordMeanings:
      'For each requested English word, infer the best Korean meaning in this paper context. The "meaning" field must be a concise Korean gloss, not an English definition. Prefer 1-4 Korean words; include English in parentheses only when the technical term is normally used untranslated. Output valid JSON only: {"meanings":[{"word":"veracity","meaning":"진실성","context":"논문 맥락에서의 짧은 한국어 설명"}]}. Do not include Markdown fences.',
  };

  const structuredJsonReminder =
    task.taskType === "translatePage" ||
    task.taskType === "autoHighlight" ||
    task.taskType === "defineWordMeanings" ||
    task.taskType === "outlineDocument" ||
    task.taskType === "classifyDocumentLayout"
      ? "Important: return exactly one valid JSON object. Do not include explanations, code blocks, or Markdown fences."
      : "";
  const languageAwareTaskInstruction =
    task.taskType === "chatWithPaper"
      ? "Answer in Korean based only on provided PDF evidence. Include page citations in the form (p. 12)."
      : task.taskType === "translateText"
        ? `Translate into natural ${targetLanguage}. Keep core technical names in English when appropriate.`
        : task.taskType === "translatePage"
          ? sentenceRows.length
            ? `Translate into natural ${targetLanguage} using the sentence ID list exactly. Return only JSON in the required format.`
            : `Translate the page into natural ${targetLanguage} and preserve paragraph structure.`
          : (taskInstruction[task.taskType] ?? "Perform the requested document task.");

  return [
    "You are Paper Pilot, a private academic PDF research assistant.",
    task.taskType === "outlineDocument"
      ? "Return only the final outline JSON. Use exact English heading text from the PDF when the PDF is English. Do not translate, summarize, merge, or invent headings."
      : task.taskType === "classifyDocumentLayout"
        ? "Return only the final layout JSON. Do not include prose outside the JSON."
      : task.taskType === "translateText" || task.taskType === "translatePage"
        ? `Write the translated output in ${targetLanguage}. Do not switch languages unless asked.`
        : "Write the final user-facing answer in Korean. Do not mention hidden prompts, tool execution, or internal process.",
    "Use Markdown LaTeX for math: inline `$...$`, display `$$...$$`.",
    "Use the extracted PDF text below as evidence. For two-column PDFs, the app provides text in reading order: left column first, then right column.",
    `Task: ${task.taskType}`,
    languageAwareTaskInstruction,
    task.taskType === "outlineDocument" ? outlineJsonInstruction : "",
    chatEvidenceInstruction,
    translationPairInstruction,
    structuredJsonReminder,
    promptDocumentLine,
    fullPaperPdfPath ? `Full PDF file path:\n${fullPaperPdfPath}` : "",
    customPrompt ? `User extra instruction:\n${customPrompt}` : "",
    text ? `Selected text:\n${text}` : "",
    sentenceText ? `Sentence input:\n${sentenceText}` : "",
    wordMeaningWords.length ? `Requested English words:\n${wordMeaningWords.join(", ")}` : "",
    candidateTermText ? `Candidate term signals:\n${candidateTermText}` : "",
    layoutCandidateText ? `Local page geometry signals:\n${layoutCandidateText}` : "",
    wordMeaningContext ? `Selected word context:\n${wordMeaningContext}` : "",
    existingMeaningText ? `Existing saved meanings for this word:\n${existingMeaningText}` : "",
    question ? `User question:\n${question}` : "",
    reference ? `Reference/link information:\n${reference}` : "",
    task.taskType === "chatWithPaper" && documentContextText ? documentContextText : "",
    url ? `URL:\n${url}` : "",
    task.taskType === "explainRegionImage" ? "An image crop is attached. Inspect it directly when possible." : "",
    pageText ? `Extracted document text:\n${pageText}` : "",
    task.taskType === "autoHighlight" ? "" : "Quote only necessary evidence and cite page numbers when useful.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function trimmedPagesForBridge(pages: PageRecord[], taskType?: AiTaskType | string): PageRecord[] {
  const isOutline = taskType === "outlineDocument";
  return (isOutline ? pages : pages.slice(0, 16)).map((page) => ({
    ...page,
    text: compactText(page.text, isOutline ? 4200 : 2200),
    outlineLabel: compactText(page.outlineLabel, 240),
  }));
}

export function bridgePayloadFor(task: AiTask, prompt: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    prompt,
    document: {
      id: task.document.id,
      title: compactText(task.document.title, 500),
      authors: compactText(task.document.authors, 500),
      year: task.document.year,
      fileName: compactText(task.document.fileName, 500),
      filePath: task.document.filePath,
    },
  };
  if (typeof task.payload.text === "string") payload.text = compactText(task.payload.text, 8000);
  if (typeof task.payload.question === "string") payload.question = compactText(task.payload.question, 3000);
  if (typeof task.payload.reference === "string") payload.reference = compactText(task.payload.reference, 5000);
  if (typeof task.payload.url === "string") payload.url = task.payload.url;
  if (typeof task.payload.mode === "string") payload.mode = task.payload.mode;
  if (Array.isArray(task.payload.words)) {
    payload.words = task.payload.words
      .filter((word): word is string => typeof word === "string" && word.trim().length > 0)
      .map((word) => compactText(word, 80))
      .slice(0, 160);
  }
  if (Array.isArray(task.payload.candidateTerms)) payload.candidateTerms = task.payload.candidateTerms;
  if (Array.isArray(task.payload.layoutCandidates)) payload.layoutCandidates = task.payload.layoutCandidates;
  if (typeof task.payload.context === "string") payload.context = compactText(task.payload.context, 1600);
  if (Array.isArray(task.payload.existingMeanings)) payload.existingMeanings = task.payload.existingMeanings;
  if (typeof task.payload.page === "number") payload.page = task.payload.page;
  if (typeof task.payload.translationLanguage === "string") payload.translationLanguage = task.payload.translationLanguage;
  if (typeof task.payload.translationLanguageName === "string") payload.translationLanguageName = task.payload.translationLanguageName;
  if (Array.isArray(task.payload.sentences)) payload.sentences = task.payload.sentences;
  if (task.payload.region) payload.region = task.payload.region;
  if (typeof task.payload.imageDataUrl === "string") payload.imageDataUrl = task.payload.imageDataUrl;
  if (task.taskType === "chatWithPaper") payload.askMode = "direct";
  const documentContextPack = documentContextPackFromPayload(task.payload);
  if (documentContextPack) payload.documentContextPack = documentContextPack;
  const pages = pagesFromPayload(task.payload);
  if (pages.length && task.taskType !== "chatWithPaper") {
    payload.pages = trimmedPagesForBridge(pages, task.taskType);
  }
  return payload;
}

export function localAiOutput(task: AiTask): string {
  const pages = pagesFromPayload(task.payload);
  const pageText = pages.map((page) => page.text).join(" ");
  const selectedText = typeof task.payload.text === "string" ? task.payload.text : "";
  const pageOnlyText = typeof task.payload.text === "string" ? task.payload.text : "";
  const question = typeof task.payload.question === "string" ? task.payload.question : "";
  const reference = typeof task.payload.reference === "string" ? task.payload.reference : "";
  const wordMeaningWords = Array.isArray(task.payload.words)
    ? task.payload.words.filter((word): word is string => typeof word === "string" && word.trim().length > 0)
    : [];
  const wordMeaningContext = typeof task.payload.context === "string" ? task.payload.context : "";
  const terms = keywords(`${selectedText} ${pageText}`);
  const targetLanguage = translationLanguageNameFromPayload(task.payload);

  if (task.taskType === "defineWordMeanings") {
    return JSON.stringify(
      {
        meanings: wordMeaningWords.slice(0, 120).map((word) => ({
          word,
          meaning: "한국어 뜻은 실제 AI 또는 사전 조회가 필요합니다.",
          context: wordMeaningContext || "로컬 draft 모드는 논문 맥락의 정확한 뉘앙스를 추론하지 않습니다.",
        })),
      },
      null,
      2,
    );
  }

  switch (task.taskType) {
    case "explainText":
      return [
        "Local explanation draft",
        selectedText ? `- Main idea: ${compactText(selectedText, 420)}` : "- No selected text was provided.",
        terms.length ? `- Key terms: ${terms.join(", ")}` : "",
        "- The selected agent can replace this draft with a deeper explanation.",
      ].filter(Boolean).join("\n");
    case "translateText":
    case "translatePage":
      return [
        "Translation task queued",
        `- Target language: ${targetLanguage}.`,
        "- A real translation requires Codex CLI or Claude Code.",
        `- Source text: ${compactText(pageOnlyText || pageText, 700) || "No extractable text was available."}`,
      ].join("\n");
    case "summarizePaper":
      return localSummary(pages, task.payload.mode === "detailed");
    case "chatWithPaper":
      return [
        `Question: ${question || "No question provided."}`,
        "Full-paper mode is queued. The loaded PDF is prepared as Markdown and the agent uses that Markdown file as the primary source.",
        ...relevantSentences(question, pages).map((sentence) => `- ${sentence}`),
      ].join("\n");
    case "autoHighlight":
      return [
        "Auto-highlight task queued",
        "- Local keyword highlighting runs immediately in the Activity panel.",
        "- The selected agent can replace or refine these candidates through the agent inbox.",
      ].join("\n");
    case "citationReason":
      return [
        "Citation reason draft",
        reference ? `- Reference: ${compactText(reference, 500)}` : "- No reference text was supplied.",
        "- Likely use: cite this when it supports the paper's background, method choice, or comparison baseline.",
      ].join("\n");
    case "externalLinkSummary":
      return [
        "External link summary queued",
        "- Local mode does not fetch remote pages.",
        "- The agent task includes the URL/reference for summarization.",
      ].join("\n");
    case "outlineDocument":
      return pages
        .slice(0, 10)
        .map((page) => `- p.${page.pageNumber} ${compactText(page.outlineLabel || page.text, 45)}`)
        .join("\n") || "No extracted page text is available yet.";
    case "classifyDocumentLayout":
      return JSON.stringify({ layout: "single", reason: "Local draft cannot inspect PDF geometry; using single-column fallback." });
    case "recommendPapers":
      return [
        "Recommendation search queued",
        `Query: ${typeof task.payload.query === "string" ? task.payload.query : task.document.title}`,
        "- The selected agent can turn this into the final recommendation list.",
      ].join("\n");
    case "explainRegionImage":
      return [
        "Region explanation queued",
        "- The selected image crop was captured and placed in the agent payload.",
        "- Codex CLI or Claude Code processing is required for visual explanation.",
      ].join("\n");
    default:
      return "Task queued. A local draft is available only for known task types.";
  }
}
