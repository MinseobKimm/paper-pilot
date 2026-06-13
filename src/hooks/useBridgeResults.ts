import { useEffect } from "react";
import type { AiResultRecord, AnnotationRecord, AppStateRecord, DocumentRecord, PageRecord } from "../types";
import { makeId, nowIso } from "../lib/ids";
import { saveAiResult, readBridgeResult, startBridgeWorker, upsertAnnotation } from "../lib/tauri";
import { normalizeComparable } from "../lib/textUtils";
import { annotationKey } from "../lib/annotationHelpers";
import { colorForHighlightTag, parseAutoHighlightCandidates } from "../lib/autoHighlights";
import { chatInputTextWithMode, wordMeaningTaskType } from "../lib/aiResults";
import {
  isStalePendingTranslation,
  stalePendingTranslationMs,
  translationInputLanguage,
  translationInputText,
  translationRequestKey,
} from "../lib/translations";
import type { UiLanguage, UiStrings } from "../lib/uiStrings";
import { estimateTokens, parseTokenEstimate, prependTokenEstimate } from "../lib/tokenEstimate";

type PatchState = (mutator: (draft: AppStateRecord) => void) => void;

type BridgeResultsInput = {
  activeDocument: DocumentRecord | null;
  activePages: PageRecord[];
  activeAnnotations: AnnotationRecord[];
  activeAiResults: AiResultRecord[];
  bridgePath: string;
  pageCursor: number;
  ui: UiStrings;
  uiLanguage: UiLanguage;
  patchState: PatchState;
  upsertAiResultInState: (result: AiResultRecord) => void;
  showToast: (message: string, kind?: "info" | "error") => void;
  translationRequestsRef: { current: Map<string, number> };
  setFloatingResultId: (id: string | null) => void;
  saveWordMeaningsFromResult: (result: AiResultRecord, fallbackWords?: string[]) => Promise<number>;
  saveDocumentLayoutFromResult: (result: AiResultRecord) => Promise<void>;
  onFastEvidenceInsufficient?: (result: AiResultRecord, metadata: Record<string, unknown>) => Promise<void>;
};

function savedChatAskMode(taskType: string, value: unknown) {
  if (taskType !== "chatWithPaper") {
    return "";
  }
  return value === "fast" || value === "deep" || value === "auto" ? value : "";
}

function aiResultContentMatches(left: AiResultRecord, right: AiResultRecord) {
  return (
    left.inputText === right.inputText &&
    left.outputText === right.outputText &&
    left.status === right.status &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.providerSessionId === right.providerSessionId
  );
}

function isStalePendingAiResult(result: AiResultRecord) {
  if (result.status !== "pending") {
    return false;
  }
  if (result.taskType.toString() === "translatePage") {
    return isStalePendingTranslation(result);
  }
  const createdAt = Date.parse(result.createdAt);
  return Number.isFinite(createdAt) && Date.now() - createdAt > stalePendingTranslationMs;
}

function isFreshPendingAiResult(result: AiResultRecord) {
  return result.status === "pending" && !isStalePendingAiResult(result);
}

export function useBridgeResults(input: BridgeResultsInput) {
  const {
    activeDocument,
    activePages,
    activeAnnotations,
    activeAiResults,
    bridgePath,
    pageCursor,
    ui,
    uiLanguage,
    patchState,
    upsertAiResultInState,
    showToast,
    translationRequestsRef,
    setFloatingResultId,
    saveWordMeaningsFromResult,
    saveDocumentLayoutFromResult,
    onFastEvidenceInsufficient,
  } = input;
  async function saveLocalAiResult(result: AiResultRecord) {
    const saved = await saveAiResult(result);
    upsertAiResultInState(saved);
    return saved;
  }

  async function saveAutoHighlightsFromResult(result: AiResultRecord) {
    if (!activeDocument || result.taskType.toString() !== "autoHighlight" || result.status === "failed") {
      return;
    }
    const fallbackPage = Number(result.inputText.match(/page\s+(\d+)/i)?.[1] ?? pageCursor) || pageCursor;
    const candidates = parseAutoHighlightCandidates(result.outputText, fallbackPage);
    if (candidates.length === 0) {
      return;
    }
    const existing = new Set(activeAnnotations.map(annotationKey));
    let savedCount = 0;
    for (const candidate of candidates) {
      const annotation: AnnotationRecord = {
        id: makeId("auto"),
        documentId: activeDocument.id,
        page: candidate.page,
        kind: "auto",
        color: colorForHighlightTag(candidate.tag),
        text: candidate.text,
        rangeHint: candidate.text.slice(0, 180),
        rects: [],
        comment: candidate.reason,
        tag: candidate.tag,
        createdAt: nowIso(),
      };
      const key = annotationKey(annotation);
      if (existing.has(key)) {
        continue;
      }
      existing.add(key);
      const saved = await upsertAnnotation(annotation);
      savedCount += 1;
      patchState((draft) => {
        draft.annotations = [saved, ...draft.annotations.filter((item) => item.id !== saved.id)];
      });
    }
    if (savedCount > 0) {
      showToast(`${savedCount}${uiLanguage === "ko" ? "" : " "}${ui.highlightsAddedSuffix}`);
    }
  }

  async function pollBridge(silent = false) {
    const pending = activeAiResults.filter((result) => result.status === "pending" && (!silent || isFreshPendingAiResult(result)));
    if (pending.length === 0) {
      if (!silent) {
        showToast(ui.noPendingAgentTasks);
      }
      return;
    }
    let received = 0;
    for (const item of pending) {
      const bridgeResult = await readBridgeResult(bridgePath, item.id);
      if (bridgeResult) {
        const metadata = bridgeResult.payload as Record<string, unknown>;
        const nestedPayload =
          metadata.payload && typeof metadata.payload === "object"
            ? (metadata.payload as Record<string, unknown>)
            : {};
        const provider =
          typeof metadata.provider === "string"
            ? metadata.provider
            : typeof nestedPayload.provider === "string"
              ? nestedPayload.provider
              : item.provider;
        const model =
          typeof metadata.model === "string"
            ? metadata.model
            : typeof nestedPayload.model === "string"
              ? nestedPayload.model
              : item.model;
        const providerSessionId =
          typeof metadata.providerSessionId === "string"
            ? metadata.providerSessionId
            : typeof nestedPayload.providerSessionId === "string"
              ? nestedPayload.providerSessionId
              : item.providerSessionId;
        const outputText = bridgeResult.output || JSON.stringify(bridgeResult.payload, null, 2);
        const pendingEstimate = parseTokenEstimate(item.outputText);
        const plannedAskMode =
          savedChatAskMode(item.taskType.toString(), nestedPayload.askMode) ||
          savedChatAskMode(item.taskType.toString(), metadata.askMode);
        const nextResult: AiResultRecord = {
          ...item,
          inputText: plannedAskMode ? chatInputTextWithMode(item.inputText, plannedAskMode) : item.inputText,
          outputText: prependTokenEstimate(outputText, {
            inputTokens: pendingEstimate.inputTokens,
            outputTokens: estimateTokens(outputText),
          }),
          status: bridgeResult.status || "complete",
          provider,
          model,
          providerSessionId,
        };
        if (bridgeResult.status === "pending" && aiResultContentMatches(item, nextResult)) {
          continue;
        }
        received += 1;
        const savedResult = await saveLocalAiResult(nextResult);
        if (item.taskType.toString() === "translatePage") {
          const page = activePages.find((candidate) => normalizeComparable(candidate.text) === normalizeComparable(translationInputText(item)));
          if (page) {
            translationRequestsRef.current.delete(
              translationRequestKey(item.documentId, page.pageNumber, page.text, translationInputLanguage(item)),
            );
          }
        }
        if (savedResult.taskType.toString() === "autoHighlight") {
          await saveAutoHighlightsFromResult(savedResult);
        }
        if (savedResult.taskType.toString() === wordMeaningTaskType) {
          await saveWordMeaningsFromResult(savedResult);
        }
        if (savedResult.taskType.toString() === "classifyDocumentLayout") {
          await saveDocumentLayoutFromResult(savedResult);
        }
        if (savedResult.taskType.toString() === "chatWithPaper") {
          await onFastEvidenceInsufficient?.(savedResult, metadata);
        }
        if (item.taskType.toString() === "translatePage" && bridgeResult.status === "failed") {
          const page = activePages.find((candidate) => normalizeComparable(candidate.text) === normalizeComparable(translationInputText(item)));
          if (page) {
            translationRequestsRef.current.delete(
              translationRequestKey(item.documentId, page.pageNumber, page.text, translationInputLanguage(item)),
            );
          }
        }
        if (["explainText", "explainRegionImage", "translateText"].includes(item.taskType.toString())) {
          setFloatingResultId(item.parentResultId || item.id);
        }
      }
    }
    if (!silent) {
      showToast(received ? `${received}${uiLanguage === "ko" ? "" : " "}${ui.receivedAgentResultsSuffix}` : ui.agentInboxChecked);
    }
  }

  async function runPendingBridgeWorkers() {
    const pending = activeAiResults.filter((result) => result.status === "pending");
    if (pending.length === 0) {
      showToast(ui.noPendingAgentTasks);
      return;
    }
    const workers = await Promise.all(pending.map((item) => startBridgeWorker(bridgePath, item.id)));
    const started = workers.filter((worker) => worker.started).length;
    const lastFailure = [...workers].reverse().find((worker) => !worker.started)?.message ?? "";
    showToast(started ? `${ui.taskStartedPrefix} ${started} ${ui.agentPending}.` : lastFailure || ui.noAgentWorkerStarted);
  }

  useEffect(() => {
    if (!activeAiResults.some(isFreshPendingAiResult)) {
      return;
    }
    const timer = window.setInterval(() => {
      void pollBridge(true);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [activeAiResults, bridgePath]);

  return {
    saveLocalAiResult,
    saveAutoHighlightsFromResult,
    pollBridge,
    runPendingBridgeWorkers,
  };
}
