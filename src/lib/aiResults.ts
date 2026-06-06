import type { AiResultRecord, AiTaskType, PageRecord } from "../types";
import { normalizeAiProviderKind } from "./ai";
import { compactUiText } from "./fileActions";
import { cleanAiOutput } from "./textUtils";
import { parseTokenEstimate, tokenEstimateMarkdown } from "./tokenEstimate";
import { parseTranslationLines, smartSentenceParts } from "./translations";
import { uiStrings, type UiStrings } from "./uiStrings";

export type AiDisplaySection = {
  id: string;
  titleKey: string;
  taskTypes: string[];
  emptyKey: string;
};

export const wordMeaningTaskType: AiTaskType = "defineWordMeanings";
export const rightPanelHiddenTasks = new Set(["translatePage", wordMeaningTaskType, "classifyDocumentLayout"]);
const chatAskPrefixPattern = /^\[(PDF direct|Fast Answer|Auto Answer|Deep Read)\]\s*/i;

export type ChatAskModeKind = "plain" | "auto" | "fast" | "deep";

export const aiDisplaySections: AiDisplaySection[] = [
  {
    id: "keywords",
    titleKey: "keywordsDict",
    taskTypes: [],
    emptyKey: "keywordsEmpty",
  },
  {
    id: "three",
    titleKey: "threeLineSummary",
    taskTypes: ["summarizePaper"],
    emptyKey: "threeLineEmpty",
  },
  {
    id: "summary",
    titleKey: "summary",
    taskTypes: ["summarizePaper"],
    emptyKey: "summaryEmpty",
  },
];

const taskLabelKeys: Record<string, string> = {
  explainText: "explain",
  explainRegionImage: "imageExplanation",
  translateText: "translate",
  translatePage: "autoTranslate",
  summarizePaper: "summary",
  chatWithPaper: "askAi",
  autoHighlight: "autoHighlightCompact",
  citationReason: "citationReason",
  externalLinkSummary: "linkSummary",
  outlineDocument: "documentOutline",
  classifyDocumentLayout: "documentOutline",
  recommendPapers: "paperRecommendations",
  defineWordMeanings: "wordMeanings",
};

export function taskTitle(taskType: string, ui: UiStrings = uiStrings.ko) {
  const key = taskLabelKeys[taskType];
  return key ? ui[key] ?? taskType : taskType;
}

export function stripChatAskPrefix(inputText: string) {
  return inputText.replace(chatAskPrefixPattern, "").trim();
}

export function chatAskModeKind(inputText: string): ChatAskModeKind {
  const tag = inputText.match(chatAskPrefixPattern)?.[1]?.toLowerCase() ?? "";
  if (tag === "auto answer") {
    return "auto";
  }
  if (tag === "fast answer") {
    return "fast";
  }
  if (tag === "deep read" || tag === "pdf direct") {
    return "deep";
  }
  return "plain";
}

export function chatAskModeLabel(inputText: string) {
  const kind = chatAskModeKind(inputText);
  if (kind === "auto") {
    return "Auto";
  }
  if (kind === "fast") {
    return "Fast";
  }
  if (kind === "deep") {
    return "Deep Read";
  }
  return "";
}

export function formatResultTime(value: string) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("ko-KR", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function getReadableAiOutput(result: AiResultRecord, ui: UiStrings = uiStrings.ko) {
  const text = cleanAiOutput(result.outputText, result.status).replace(/^Token estimate:[^\n]*(?:\n\n)?/, "");
  if (result.taskType.toString().startsWith("translate") && result.status !== "pending") {
    const translations = parseTranslationLines(text, 0);
    if (translations.length) {
      return translations.join("\n");
    }
  }
  if (result.status === "pending") {
    return text || ui.aiPendingAnswer;
  }
  return text || ui.noAnswerContent;
}

export function resultTokenEstimateText(result: AiResultRecord) {
  return tokenEstimateMarkdown(parseTokenEstimate(result.outputText)).replace(/^Token estimate:\s*/, "");
}

export function latestResult(results: AiResultRecord[], taskTypes: string[]) {
  return results.find((result) => taskTypes.includes(result.taskType.toString()) && result.status !== "pending");
}

export function resultSummaryMode(result: AiResultRecord) {
  return result.inputText.match(/^\[summary:\s*([^,\]]+)/i)?.[1] ?? "";
}

export function latestInsightResult(results: AiResultRecord[], section: AiDisplaySection) {
  if (section.id === "keywords") {
    return undefined;
  }
  if (section.id === "three") {
    return results.find(
      (result) =>
        result.taskType.toString() === "summarizePaper" &&
        result.status !== "pending" &&
        resultSummaryMode(result) === "three-line",
    );
  }
  if (section.id === "summary") {
    return results.find(
      (result) =>
        result.taskType.toString() === "summarizePaper" &&
        result.status !== "pending" &&
        resultSummaryMode(result) !== "three-line",
    );
  }
  return latestResult(results, section.taskTypes);
}

export function limitInsightText(sectionId: string, text: string) {
  const clean = text.trim();
  if (!clean || sectionId === "keywords") {
    return "";
  }
  const lines = clean
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (sectionId === "three") {
    const sourceLines = lines.length >= 2 ? lines : smartSentenceParts(clean);
    return sourceLines
      .slice(0, 3)
      .map((line) => line.replace(/^[-*\s]+/, "").replace(/^\d+[.)]\s*/, "").trim())
      .filter(Boolean)
      .map((line) => `- ${compactUiText(line, 72)}`)
      .join("\n");
  }
  if (sectionId === "summary") {
    return compactUiText(lines.slice(0, 5).join("\n"), 760);
  }
  return clean;
}

export function resultPreviewText(result: AiResultRecord, ui: UiStrings = uiStrings.ko) {
  const text = getReadableAiOutput(result, ui);
  if (result.taskType.toString() === "summarizePaper") {
    return limitInsightText(resultSummaryMode(result) === "three-line" ? "three" : "summary", text);
  }
  if (result.taskType.toString() === "outlineDocument") {
    return compactUiText(
      text
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, 10)
        .join("\n"),
      700,
    );
  }
  return text;
}

export function latestProviderSessionId(results: AiResultRecord[], provider: string) {
  return (
    results.find(
      (result) =>
        result.status !== "failed" &&
        normalizeAiProviderKind(result.provider ?? provider) === provider &&
        typeof result.providerSessionId === "string" &&
        result.providerSessionId.length > 0,
    )?.providerSessionId ?? ""
  );
}

export function keywordChipsFromText(text: string, limit = 10) {
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
    "model",
    "models",
    "language",
    "reasoning",
  ]);
  const counts = new Map<string, number>();
  for (const word of text.match(/[A-Za-z][A-Za-z-]{3,}/g) ?? []) {
    const key = word.toLowerCase();
    if (stop.has(key)) {
      continue;
    }
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

export function pageTextPreview(page: PageRecord | undefined, ui: UiStrings = uiStrings.ko) {
  if (!page?.text) {
    return ui.pageTranslationFallback;
  }
  return smartSentenceParts(page.text)
    .slice(0, 10)
    .join(" ")
    .trim();
}
