import { useEffect } from "react";
import type { AiResultRecord, AnnotationRecord, AppStateRecord, DocumentRecord, PageRecord } from "../types";
import { makeId, nowIso } from "../lib/ids";
import { saveAiResult, readBridgeResult, startBridgeWorker, upsertAnnotation } from "../lib/tauri";
import { normalizeComparable } from "../lib/textUtils";
import { annotationKey } from "../lib/annotationHelpers";
import { colorForHighlightTag, parseAutoHighlightCandidates } from "../lib/autoHighlights";
import { wordMeaningTaskType } from "../lib/aiResults";
import { isStalePendingTranslation, translationInputLanguage, translationInputText, translationRequestKey } from "../lib/translations";
import type { UiLanguage, UiStrings } from "../lib/uiStrings";

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
  showToast: (message: string, kind?: "info" | "error") => void;
  translationRequestsRef: { current: Map<string, number> };
  setFloatingResultId: (id: string | null) => void;
  saveWordMeaningsFromResult: (result: AiResultRecord, fallbackWords?: string[]) => Promise<number>;
  saveDocumentLayoutFromResult: (result: AiResultRecord) => Promise<void>;
};

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
    showToast,
    translationRequestsRef,
    setFloatingResultId,
    saveWordMeaningsFromResult,
    saveDocumentLayoutFromResult,
  } = input;
  async function saveLocalAiResult(result: AiResultRecord) {
    const saved = await saveAiResult(result);
    patchState((draft) => {
      draft.aiResults = [saved, ...draft.aiResults.filter((item) => item.id !== saved.id)];
    });
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
    const pending = activeAiResults.filter((result) => result.status === "pending");
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
        received += 1;
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
        const savedResult = await saveLocalAiResult({
          ...item,
          outputText: bridgeResult.output || JSON.stringify(bridgeResult.payload, null, 2),
          status: bridgeResult.status || "complete",
          provider,
          model,
          providerSessionId,
        });
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
        if (item.taskType.toString() === "translatePage" && bridgeResult.status === "failed") {
          const page = activePages.find((candidate) => normalizeComparable(candidate.text) === normalizeComparable(translationInputText(item)));
          if (page) {
            translationRequestsRef.current.delete(
              translationRequestKey(item.documentId, page.pageNumber, page.text, translationInputLanguage(item)),
            );
          }
        }
        if (["explainText", "explainRegionImage", "translateText"].includes(item.taskType.toString())) {
          setFloatingResultId(item.id);
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
    if (
      !activeAiResults.some(
        (result) => result.status === "pending" && (result.taskType.toString() !== "translatePage" || !isStalePendingTranslation(result)),
      )
    ) {
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
