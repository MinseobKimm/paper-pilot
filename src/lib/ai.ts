import type {
  AiProviderKind,
  AiResultRecord,
  AiRetrievalPlan,
  AiTaskType,
  AskMode,
  DocumentContextPack,
  DocumentRecord,
  PageRecord,
  RagContext,
  RagHit,
  SelectedPageText,
} from "../types";
import { makeId, nowIso } from "./ids";
import { saveAiResult, writeBridgeTask } from "./tauri";

export type AiTask = {
  taskType: AiTaskType;
  document: DocumentRecord;
  payload: Record<string, unknown>;
};

export interface AiProvider {
  run(task: AiTask): Promise<AiResultRecord>;
}

export function normalizeAiProviderKind(kind: string | null | undefined): AiProviderKind {
  if (kind === "claude-code") {
    return "claude-code";
  }
  if (kind === "local-draft" || kind === "api-provider") {
    return "local-draft";
  }
  return "codex-cli";
}

export function isAgentProvider(kind: string | null | undefined): boolean {
  return normalizeAiProviderKind(kind) !== "local-draft";
}

export class AgentCliProvider implements AiProvider {
  constructor(
    private readonly bridgePath: string,
    private readonly provider: AiProviderKind,
  ) {}

  async run(task: AiTask): Promise<AiResultRecord> {
    const prompt = buildAiPrompt(task);
    const providerSessionId =
      typeof task.payload.providerSessionId === "string" ? task.payload.providerSessionId : undefined;
    const model = typeof task.payload.model === "string" ? task.payload.model : undefined;
    const reasoningEffort =
      typeof task.payload.reasoningEffort === "string" ? task.payload.reasoningEffort : undefined;
    const bridgePayload = bridgePayloadFor(task, prompt);
    const bridgeTask = await writeBridgeTask(
      this.bridgePath,
      task.taskType,
      task.document.id,
      this.provider,
      model,
      reasoningEffort,
      providerSessionId,
      bridgePayload,
    );
    const taskLocation = bridgeTask.filePath
      ? `\n\nAgent task: ${bridgeTask.filePath}`
      : `\n\nAgent task: ${this.bridgePath}/outbox/${bridgeTask.id}.json`;
    return saveAiResult({
      id: bridgeTask.id,
      documentId: task.document.id,
      taskType: task.taskType,
      inputText: inputTextFor(task.payload),
      outputText: `${localAiOutput(task)}${taskLocation}\nStatus: waiting for ${providerLabel(this.provider)}.`,
      status: "pending",
      createdAt: bridgeTask.createdAt,
      provider: this.provider,
      model,
      providerSessionId,
    });
  }
}

export class LocalDraftProvider implements AiProvider {
  async run(task: AiTask): Promise<AiResultRecord> {
    return saveAiResult({
      id: makeId("local"),
      documentId: task.document.id,
      taskType: task.taskType,
      inputText: inputTextFor(task.payload),
      outputText: localAiOutput(task),
      status: "complete",
      createdAt: nowIso(),
      provider: "local-draft",
    });
  }
}

export function providerFor(kind: AiProviderKind | string, bridgePath: string): AiProvider {
  const provider = normalizeAiProviderKind(kind);
  if (provider === "local-draft") {
    return new LocalDraftProvider();
  }
  return new AgentCliProvider(bridgePath, provider);
}

export async function runAiTask(
  providerKind: AiProviderKind | string,
  bridgePath: string,
  taskType: AiTaskType,
  document: DocumentRecord,
  payload: Record<string, unknown>,
): Promise<AiResultRecord> {
  return providerFor(providerKind, bridgePath).run({ taskType, document, payload });
}

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

function providerLabel(provider: AiProviderKind): string {
  if (provider === "claude-code") {
    return "Claude Code";
  }
  if (provider === "local-draft") {
    return "Local draft";
  }
  return "Codex CLI";
}

function inputTextFor(payload: Record<string, unknown>): string {
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
  'Extract the document outline from the whole PDF text. Return ONLY JSON with this exact shape: {"outline":[{"number":"1.1","title":"1.1 Related Works","page":3,"level":1,"anchorText":"1.1 Related Works"}]}. Include only headings that explicitly start with numeric section labels such as 1, 1.1, 1.1.1. Exclude Abstract, References, appendix labels without a numeric section number, captions, equations, body sentences, citations, and invented summaries. Keep title text exactly as it appears in the PDF, in English if the PDF is English. Page must be the page where that heading begins. Sort by numeric section order.';

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

function askModeFromPayload(payload: Record<string, unknown>): AskMode | null {
  return payload.askMode === "direct" || payload.askMode === "planned" ? payload.askMode : null;
}

function selectedPageTextsFromPayload(payload: Record<string, unknown>): SelectedPageText[] {
  if (!Array.isArray(payload.selectedPageTexts)) {
    return [];
  }
  return payload.selectedPageTexts
    .map((value, index): SelectedPageText | null => {
      if (!value || typeof value !== "object") {
        return null;
      }
      const record = value as Record<string, unknown>;
      const pageNumber = typeof record.pageNumber === "number" ? record.pageNumber : null;
      const text = typeof record.text === "string" ? record.text : "";
      if (!pageNumber || !text.trim()) {
        return null;
      }
      return {
        pageNumber,
        text,
        charCount: typeof record.charCount === "number" ? record.charCount : text.length,
      };
    })
    .filter((item): item is SelectedPageText => item !== null);
}

function retrievalPlanFromPayload(payload: Record<string, unknown>): AiRetrievalPlan | null {
  const value = payload.retrievalPlan;
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const selectedPages = Array.isArray(record.selectedPages)
    ? record.selectedPages
        .map((item) => (typeof item === "number" ? Math.round(item) : Number(item)))
        .filter((item) => Number.isFinite(item) && item > 0)
    : [];
  if (selectedPages.length === 0) {
    return null;
  }
  const confidence =
    record.confidence === "high" || record.confidence === "medium" || record.confidence === "low"
      ? record.confidence
      : "low";
  return {
    selectedPages: [...new Set(selectedPages)].slice(0, 12),
    reason: typeof record.reason === "string" ? compactText(record.reason, 1200) : "",
    confidence,
  };
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

function formatRetrievalPlanForPrompt(plan: AiRetrievalPlan): string {
  return [
    `Retrieval plan confidence: ${plan.confidence}`,
    `Selected pages: ${plan.selectedPages.map((page) => `p.${page}`).join(", ")}`,
    plan.reason ? `Reason: ${plan.reason}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatSelectedPageTextsForPrompt(rows: SelectedPageText[]): string {
  return rows
    .map((row) => [`Page ${row.pageNumber}:`, compactText(row.text, 100000)].join("\n"))
    .join("\n\n");
}

function ragHitFromValue(value: unknown, index: number): RagHit | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const pageNumber = typeof record.pageNumber === "number" ? record.pageNumber : null;
  const text = typeof record.text === "string" ? record.text : "";
  if (pageNumber === null || !text) {
    return null;
  }
  return {
    id: typeof record.id === "string" ? record.id : `rag-${index}`,
    documentId: typeof record.documentId === "string" ? record.documentId : "",
    pageNumber,
    chunkIndex: typeof record.chunkIndex === "number" ? record.chunkIndex : index,
    text,
    score: typeof record.score === "number" ? record.score : 0,
    matchedTerms: Array.isArray(record.matchedTerms)
      ? record.matchedTerms.filter((term): term is string => typeof term === "string")
      : [],
  };
}

function ragContextFromPayload(payload: Record<string, unknown>): RagContext | null {
  const value = payload.ragContext;
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const hits = Array.isArray(record.hits)
    ? record.hits.map(ragHitFromValue).filter((hit): hit is RagHit => hit !== null)
    : [];
  return {
    query: typeof record.query === "string" ? compactText(record.query, 3000) : "",
    hits,
    hitCount: typeof record.hitCount === "number" ? record.hitCount : hits.length,
    totalChunks: typeof record.totalChunks === "number" ? record.totalChunks : 0,
    hasStrongMatch: record.hasStrongMatch === true,
    maxChars: typeof record.maxChars === "number" ? record.maxChars : 6000,
  };
}

function formatRagContextForPrompt(context: RagContext): string {
  if (context.hits.length === 0) {
    return [
      `RAG query: ${context.query || "(empty)"}`,
      `Total chunks searched: ${context.totalChunks}`,
      "No matching excerpts were found in the extracted PDF text.",
    ].join("\n");
  }
  return [
    `RAG query: ${context.query || "(empty)"}`,
    `Match quality: ${context.hasStrongMatch ? "strong" : "weak"}`,
    `Retrieved excerpts: ${context.hits.length} of ${context.totalChunks} chunks searched`,
    ...context.hits.map((hit, index) =>
      [
        `[R${index + 1}] p.${hit.pageNumber} score=${hit.score.toFixed(2)}`,
        compactText(hit.text, 1200),
      ].join("\n"),
    ),
  ].join("\n\n");
}

function trimRagContextForBridge(context: RagContext): RagContext {
  return {
    ...context,
    hits: context.hits.slice(0, 6).map((hit) => ({
      ...hit,
      text: compactText(hit.text, 1200),
      matchedTerms: hit.matchedTerms.slice(0, 12),
    })),
  };
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
  const ragContext = ragContextFromPayload(task.payload);
  const askMode = askModeFromPayload(task.payload);
  const documentContextPack = documentContextPackFromPayload(task.payload);
  const retrievalPlan = retrievalPlanFromPayload(task.payload);
  const selectedPageTexts = selectedPageTextsFromPayload(task.payload);
  const useSelectedPageTexts = task.taskType === "chatWithPaper" && selectedPageTexts.length > 0;
  const useRagContext = task.taskType === "chatWithPaper" && !useSelectedPageTexts && ragContext !== null;
  const pageTextLimit =
    task.taskType === "translatePage"
      ? 3600
      : task.taskType === "chatWithPaper" || task.taskType === "explainRegionImage"
        ? 2800
        : task.taskType === "outlineDocument"
          ? 120000
          : task.taskType === "defineWordMeanings"
            ? 22000
          : task.taskType === "summarizePaper"
            ? 5200
            : 6500;
  const pageText = useRagContext || useSelectedPageTexts
    ? ""
    : compactText(
        pages
          .map((page) => {
            const limit =
              task.taskType === "outlineDocument"
                ? pages.length > 160
                  ? 520
                  : pages.length > 80
                    ? 820
                    : 1400
                : task.taskType === "defineWordMeanings"
                  ? 1400
                : task.taskType === "summarizePaper"
                  ? 520
                  : 760;
            const source =
              task.taskType === "outlineDocument"
                ? [page.outlineLabel, page.text.slice(0, 1600)].filter(Boolean).join(" ")
                : page.outlineLabel || page.text;
            return `Page ${page.pageNumber}: ${compactText(source, limit)}`;
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
  const documentLine = `문서: ${task.document.title || "제목 없음"}${task.document.authors ? ` / 저자: ${task.document.authors}` : ""}${
    task.document.year ? ` / 연도: ${task.document.year}` : ""
  }`;
  const documentContextText = documentContextPack ? formatDocumentContextPackForPrompt(documentContextPack) : "";
  const retrievalPlanText = retrievalPlan ? formatRetrievalPlanForPrompt(retrievalPlan) : "";
  const selectedPageText = useSelectedPageTexts ? formatSelectedPageTextsForPrompt(selectedPageTexts) : "";
  const ragText = useRagContext && ragContext ? formatRagContextForPrompt(ragContext) : "";
  const ragInstruction =
    useRagContext && ragContext
      ? "A local lexical fallback retrieval context is provided because the AI page planner was unavailable or unusable. Use it only as candidate evidence, cite pages inline like (p. 3), and do not conclude evidence is insufficient until the provided excerpts have been checked."
      : "";
  const chatEvidenceInstruction =
    task.taskType === "chatWithPaper"
      ? useSelectedPageTexts
        ? [
            "Write the final answer in Korean.",
            askMode === "planned"
              ? "This is the second stage of a hybrid whole-paper search. Use the selected exact page texts as primary evidence; use the Document Context Pack and retrieval plan only as navigation context."
              : "This short PDF fits in context. Use the selected page texts as the full extracted paper text.",
            "Cite factual claims with page markers in one consistent format: (p. 12). Do not cite pages that are not present in the selected page text.",
            "If the selected exact page texts do not contain enough evidence, say that after checking those pages, and mention which pages were checked.",
          ].join(" ")
        : ""
      : "";
  if (task.taskType === "chatWithPaperPlan") {
    return [
      "You are the hidden retrieval planner for Paper Pilot.",
      "Do not answer the user's question. Select where the app should look in the PDF.",
      "The user question may be Korean while the paper is often English. Interpret the meaning semantically yourself; do not rely on hard-coded word mapping.",
      'Return JSON only, with this exact shape: {"selectedPages":[12,13],"reason":"short reason","confidence":"high|medium|low"}.',
      "Pick pages likely to contain direct evidence. Prefer concrete theorem/proof/appendix/result/limitation pages when the question implies them. If uncertain, choose broad likely pages instead of returning an empty list.",
      "Use 1 to 8 unique page numbers from the document page range.",
      documentLine,
      customPrompt ? `User extra instruction:\n${customPrompt}` : "",
      question ? `User question:\n${question}` : "",
      documentContextText,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  const translationPairInstruction =
    task.taskType === "translatePage"
      ? `Translate the full source text into natural ${targetLanguage}, but keep alignment exact. Use the provided sentence IDs as the only alignment source. Return one JSON item per translated sentence ID; do not group multiple IDs into one item. For each item, sourceIds must contain exactly one provided ID, and source must be copied exactly from that ID source text. Do not invent, renumber, reorder, or omit source IDs for translated prose. The translation field must be written in ${targetLanguage}. Keep core paper concept terms in English exactly as written when they are model names, method names, task names, dataset/benchmark names, metrics, acronyms, named components, or field-specific technical keywords; translate the surrounding sentence naturally into ${targetLanguage} without forcing local-language equivalents for those terms. Include prose captions, legends, and descriptions attached to figures, photos, graphs, charts, or tables when they explain the visual. Skip only table/chart/graph internals such as cell values, axis labels, tick labels, legend keys without prose, numeric-only fragments, headers/footers, references, and PDF extraction noise unless they are essential prose. Output only valid JSON: {"pairs":[{"sourceIds":["p1-s0"],"source":"exact original sentence for p1-s0","translation":"${targetLanguage} translation"}]}. Keep equations and LaTeX readable in Markdown LaTeX. Do not add explanations or Markdown fences.`
      : "";
  const taskInstruction: Record<string, string> = {
    explainText:
      "선택한 문장을 논문 맥락에서 설명해. 핵심 의미, 필요한 배경, 수식/기호/전문 용어를 한국어로 풀어 써.",
    explainRegionImage:
      "첨부된 이미지 영역을 먼저 확인하고, 보이는 그림/표/수식/텍스트를 논문 맥락에서 한국어로 설명해. 이미지가 불명확하면 주변 추출 텍스트를 보조 근거로 사용해.",
    translateText:
      "선택한 텍스트를 자연스러운 한국어로 번역해. 논문의 핵심 개념 단어, 모델명, 방법명, 태스크명, 데이터셋명, 벤치마크명, 지표명, 약어, 고유 구성요소명은 영어 원문 그대로 유지해.",
    translatePage: sentenceRows.length
      ? '아래 sentence id 목록을 기준으로 페이지를 자연스러운 한국어로 번역해. 각 출력 항목은 sentence id 하나만 담당해야 하며 sourceIds에는 정확히 그 id 하나만 넣어. source는 해당 id의 원문을 그대로 복사해. 클릭 동기화가 sourceIds와 source 검증으로만 동작하므로 sourceIds/source를 틀리거나 빠뜨리면 안 된다. 논문의 핵심 개념 단어, 모델명, 방법명, 태스크명, 데이터셋명, 벤치마크명, 지표명, 약어, 고유 구성요소명은 영어 원문 그대로 유지해. 반드시 유효한 JSON만 출력해. 형식: {"pairs":[{"sourceIds":["p1-s0"],"source":"원문","translation":"..."}]}. LaTeX는 JSON 문자열 안에서 Markdown LaTeX로 보존해.'
      : "페이지 텍스트를 자연스러운 한국어로 번역하고 문단 구조를 유지해. 논문의 핵심 개념 단어, 모델명, 방법명, 태스크명, 데이터셋명, 벤치마크명, 지표명, 약어, 고유 구성요소명은 영어 원문 그대로 유지해.",
    summarizePaper:
      task.payload.mode === "detailed"
        ? "논문의 배경, 문제의식, 방법, 결과, 한계를 5개 bullet 이하로 요약해. 전체 700자 이내로, 각 bullet은 한 문장만 써."
        : "논문의 핵심 내용을 정확히 3줄로 요약해. 각 줄은 '- '로 시작하고 45자 이내로 써. 서론이나 마무리 문장은 쓰지 마.",
    chatWithPaper:
      "사용자의 질문에 논문 내용만 근거로 답해. 확실하지 않은 내용은 불확실하다고 말하고, 가능한 경우 페이지 번호나 근거 문구를 함께 제시해.",
    autoHighlight:
      '현재 페이지에서 중요한 주장, 방법, 결과, 한계 문장을 골라 하이라이트 후보로 제안해. 반드시 JSON만 출력해. 형식: {"highlights":[{"page":1,"text":"원문 문장","tag":"Methods","reason":"짧은 이유"}]}. text에는 PDF에 실제로 있는 원문 문장을 그대로 넣어.',
    citationReason:
      "이 참고문헌을 왜 인용할 수 있는지 논문 작성 관점에서 구체적으로 설명해.",
    externalLinkSummary:
      "제공된 링크 또는 참고문헌 정보를 바탕으로 핵심 내용을 요약해. 웹 접근이 불가능하면 제공된 정보만 근거로 답해.",
    outlineDocument:
      "문서 목차를 페이지 순서대로 최대 60개 항목으로 뽑아. PDF에 실제로 등장하는 섹션/하위섹션 소제목만 원문 언어 그대로 사용해. 제목을 한국어로 번역하거나 요약하거나 새로 만들지 마. 표/그래프 축 숫자, 수식, 본문 문장, 인용문, 참고문헌 조각은 절대 목차에 넣지 마. 각 줄은 반드시 '- p.페이지번호 원문소제목' 형식으로만 써. 페이지 번호는 오름차순이어야 하고, 소제목 외 설명 문장은 붙이지 마.",
    recommendPapers:
      "현재 문서와 폴더 주제에 이어서 읽을 만한 논문을 추천하고, 추천 이유를 붙여.",
    defineWordMeanings:
      'For each requested English word, infer the best Korean meaning in this paper context. Use the extracted PDF text, candidate signals, and the selected sentence/context when provided. If existing meanings are provided, do not rewrite or delete them; return only a new paper-context meaning that can be stored alongside them. Output only valid JSON with this exact shape: {"meanings":[{"word":"veracity","meaning":"진실성","context":"short Korean note about the paper-specific usage"}]}. Do not include Markdown fences.',
  };

  const structuredJsonReminder =
    task.taskType === "translatePage" || task.taskType === "autoHighlight" || task.taskType === "defineWordMeanings"
      ? "중요: 설명, 코드블록, Markdown fence 없이 JSON 객체 하나만 출력해."
      : "";
  const languageAwareTaskInstruction =
    task.taskType === "chatWithPaper"
      ? "Answer the user's question based only on the provided PDF evidence. Write the final answer in Korean and include page citations in one consistent format like (p. 12) for claims grounded in the paper."
      : task.taskType === "translateText"
      ? `Translate the selected text into natural ${targetLanguage}. Keep core paper concept terms in English exactly as written when they are model names, method names, task names, dataset/benchmark names, metrics, acronyms, named components, or field-specific technical keywords.`
      : task.taskType === "translatePage"
        ? sentenceRows.length
          ? `Translate the page into natural ${targetLanguage} using the sentence id list below. Each output item must correspond to exactly one sentence id, sourceIds must contain exactly that one id, and source must copy the original text for that id exactly. The translation field must be written in ${targetLanguage}. Keep core paper concept terms in English when appropriate. Return only valid JSON in the required format.`
          : `Translate the page text into natural ${targetLanguage} and preserve paragraph structure. Keep core paper concept terms in English when appropriate.`
        : (taskInstruction[task.taskType] ?? "사용자의 문서 작업을 수행해.");

  return [
    "너는 Paper Pilot 안에서 동작하는 개인 학술 PDF 리서치 어시스턴트다.",
    task.taskType === "outlineDocument"
      ? "사용자가 바로 읽을 수 있는 최종 목차만 작성해. 내부 도구, 실행 환경, 진행 과정은 언급하지 마. 목차 제목은 PDF 원문 언어 그대로 유지해."
      : task.taskType === "translateText" || task.taskType === "translatePage"
        ? `Write the translated output in ${targetLanguage}. Do not switch back to Korean unless the target language is Korean. Only provide the final user-facing result.`
        : "항상 한국어로 답하고, 사용자가 바로 읽을 수 있는 최종 답변만 작성해. 내부 도구, 실행 환경, 진행 과정은 언급하지 마.",
    "수식은 Markdown LaTeX로 작성해. 인라인 수식은 `$...$`, 별도 수식은 `$$...$$`만 사용해.",
    "원본 PDF와 아래 추출 텍스트를 근거로 사용해. 추출 텍스트는 페이지/문장 정렬을 위한 보조 입력이다.",
    `작업: ${task.taskType}`,
    languageAwareTaskInstruction,
    task.taskType === "outlineDocument" ? outlineJsonInstruction : "",
    chatEvidenceInstruction,
    translationPairInstruction,
    ragInstruction,
    structuredJsonReminder,
    documentLine,
    customPrompt ? `사용자 추가 지시:\n${customPrompt}` : "",
    text ? `선택 텍스트:\n${text}` : "",
    sentenceText ? `문장 단위 입력:\n${sentenceText}` : "",
    wordMeaningWords.length ? `Requested English words:\n${wordMeaningWords.join(", ")}` : "",
    candidateTermText ? `Candidate term signals:\n${candidateTermText}` : "",
    wordMeaningContext ? `Selected word context:\n${wordMeaningContext}` : "",
    existingMeaningText ? `Existing saved meanings for this word:\n${existingMeaningText}` : "",
    question ? `사용자 질문:\n${question}` : "",
    reference ? `참고문헌/링크 정보:\n${reference}` : "",
    task.taskType === "chatWithPaper" && documentContextText ? documentContextText : "",
    retrievalPlanText ? `Retrieval plan:\n${retrievalPlanText}` : "",
    selectedPageText ? `Selected exact page text:\n${selectedPageText}` : "",
    ragText ? `Retrieved RAG context:\n${ragText}` : "",
    url ? `URL:\n${url}` : "",
    task.taskType === "explainRegionImage" ? "이미지 파일이 함께 첨부될 수 있다. 가능하면 이미지를 직접 확인해 답해." : "",
    pageText ? `추출된 문서 텍스트:\n${pageText}` : "",
    task.taskType === "autoHighlight" ? "" : "필요할 때만 페이지 번호나 근거 문구를 짧게 인용해.",
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

function bridgePayloadFor(task: AiTask, prompt: string): Record<string, unknown> {
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
  if (typeof task.payload.context === "string") payload.context = compactText(task.payload.context, 1600);
  if (Array.isArray(task.payload.existingMeanings)) payload.existingMeanings = task.payload.existingMeanings;
  if (typeof task.payload.page === "number") payload.page = task.payload.page;
  if (typeof task.payload.translationLanguage === "string") payload.translationLanguage = task.payload.translationLanguage;
  if (typeof task.payload.translationLanguageName === "string") payload.translationLanguageName = task.payload.translationLanguageName;
  if (Array.isArray(task.payload.sentences)) payload.sentences = task.payload.sentences;
  if (task.payload.region) payload.region = task.payload.region;
  if (typeof task.payload.imageDataUrl === "string") payload.imageDataUrl = task.payload.imageDataUrl;
  const askMode = askModeFromPayload(task.payload);
  if (askMode) payload.askMode = askMode;
  const documentContextPack = documentContextPackFromPayload(task.payload);
  if (documentContextPack) payload.documentContextPack = documentContextPack;
  const retrievalPlan = retrievalPlanFromPayload(task.payload);
  if (retrievalPlan) payload.retrievalPlan = retrievalPlan;
  const selectedPageTexts = selectedPageTextsFromPayload(task.payload);
  if (selectedPageTexts.length) {
    payload.selectedPageTexts = selectedPageTexts.map((row) => ({
      ...row,
      text: compactText(row.text, 100000),
    }));
  }
  const ragContext = ragContextFromPayload(task.payload);
  if (ragContext) payload.ragContext = trimRagContextForBridge(ragContext);
  const pages = pagesFromPayload(task.payload);
  if (pages.length && task.taskType !== "chatWithPaper" && task.taskType !== "chatWithPaperPlan") {
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
  const ragContext = ragContextFromPayload(task.payload);
  const selectedPageTexts = selectedPageTextsFromPayload(task.payload);
  const askMode = askModeFromPayload(task.payload);
  const wordMeaningWords = Array.isArray(task.payload.words)
    ? task.payload.words.filter((word): word is string => typeof word === "string" && word.trim().length > 0)
    : [];
  const wordMeaningContext = typeof task.payload.context === "string" ? task.payload.context : "";
  const terms = keywords(`${selectedText} ${pageText}`);
  const targetLanguage = translationLanguageNameFromPayload(task.payload);

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
    case "chatWithPaperPlan":
      return JSON.stringify(
        {
          selectedPages: [1],
          reason: "Local draft mode cannot run the hidden AI retrieval planner.",
          confidence: "low",
        },
        null,
        2,
      );
    case "chatWithPaper":
      if (selectedPageTexts.length) {
        return [
          `Question: ${question || "No question provided."}`,
          `Hybrid Ask AI mode: ${askMode ?? "direct"}.`,
          `Selected exact pages: ${selectedPageTexts.map((row) => `p.${row.pageNumber}`).join(", ")}.`,
          "- A real final answer requires Codex CLI or Claude Code.",
          ...selectedPageTexts.slice(0, 4).map((row) => `- p.${row.pageNumber}: ${compactText(row.text, 420)}`),
        ].join("\n");
      }
      if (ragContext) {
        return [
          `Question: ${question || "No question provided."}`,
          ragContext.hasStrongMatch
            ? "Retrieved local RAG excerpts:"
            : "Retrieved local RAG excerpts are weak or empty; the final answer should say if evidence is insufficient.",
          ...(ragContext.hits.length
            ? ragContext.hits.map((hit) => `- p.${hit.pageNumber}: ${compactText(hit.text, 420)}`)
            : ["- No matching excerpts were found in the extracted PDF text."]),
        ].join("\n");
      }
      return [
        `Question: ${question || "No question provided."}`,
        "Relevant local excerpts:",
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
    case "recommendPapers":
      return [
        "Recommendation search queued",
        `Query: ${typeof task.payload.query === "string" ? task.payload.query : task.document.title}`,
        "- The selected agent can turn this into the final recommendation list.",
      ].join("\n");
    case "defineWordMeanings":
      return JSON.stringify(
        {
          meanings: wordMeaningWords.slice(0, 120).map((word) => ({
            word,
            meaning: `${word}의 논문 맥락상 한국어 뜻`,
            context: wordMeaningContext || "Local draft mode cannot infer the exact paper-specific nuance.",
          })),
        },
        null,
        2,
      );
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

export function makeLocalAiResult(
  documentId: string,
  taskType: AiTaskType,
  inputText: string,
  outputText: string,
  status: AiResultRecord["status"] = "complete",
): AiResultRecord {
  return {
    id: makeId("ai"),
    documentId,
    taskType,
    inputText,
    outputText,
    status,
    createdAt: nowIso(),
    provider: "local-draft",
  };
}
