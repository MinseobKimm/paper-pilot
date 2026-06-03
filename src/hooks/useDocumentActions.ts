import { useState } from "react";
import type { AiResultRecord, AiTaskType, AnnotationRecord, AppStateRecord, DocumentRecord, NoteRecord, PageRecord } from "../types";
import type { PdfDocumentProxy } from "../lib/pdfDocument";
import { nowIso } from "../lib/ids";
import { extractReferences } from "../lib/citations";
import { buildPdfFromJpegPages, createTranslatedSharePage, renderPdfPageDataUrl, type SharePdfPage } from "../lib/pdfShare";
import { externalPreviewSummary, hostFromUrl, isRegionPreviewKind, renderPdfPageRegionDataUrl, resolvePdfDestinationPage, type LinkPreviewState, type PdfLinkPreviewTarget } from "../lib/linkPreviews";
import { openExternalUrl, resolveCitationLink } from "../lib/scholarly";
import { getReadableAiOutput } from "../lib/aiResults";
import { explanationResultId } from "../lib/annotationHelpers";
import { normalizeForMatch } from "../lib/textUtils";
import { downloadBytes, downloadText, safeFileName, saveBytesWithBrowserPicker } from "../lib/fileActions";
import { deleteAiResults, deleteAnnotation, deleteNote, exportDocumentJson, exportDocumentZip, isTauriRuntime, savePdfFile, setSetting, updateDocument, upsertCitationCard, upsertNote } from "../lib/tauri";
import type { UiLanguage, UiStrings } from "../lib/uiStrings";

type PatchState = (mutator: (draft: AppStateRecord) => void) => void;

type QueueTask = (
  taskType: AiTaskType,
  payload: Record<string, unknown>,
  options?: { silent?: boolean; keepPanel?: boolean },
) => Promise<AiResultRecord | null>;

type DocumentActionsInput = {
  state: AppStateRecord;
  activeDocument: DocumentRecord | null;
  activePages: PageRecord[];
  activeCitations: ReturnType<typeof extractReferences>;
  activeAnnotations: AnnotationRecord[];
  activeAiResults: AiResultRecord[];
  activeNote: NoteRecord | null;
  floatingResultId: string | null;
  pdfDocument: PdfDocumentProxy | null;
  pageImages: Record<number, string>;
  translationLanguageName: string;
  ui: UiStrings;
  uiLanguage: UiLanguage;
  patchState: PatchState;
  showToast: (message: string, kind?: "info" | "error") => void;
  queueTask: QueueTask;
  goToPage: (page: number) => void;
  ensureActivePages: () => Promise<PageRecord[]>;
  setIsBusy: (busy: boolean) => void;
  setActivePanel: (panel: "ai" | "activity" | "citations" | "notes" | "info") => void;
  setFloatingResultId: (id: string | null) => void;
  setRightPanelOpen: (open: boolean) => void;
};

export function useDocumentActions(input: DocumentActionsInput) {
  const {
    state,
    activeDocument,
    activePages,
    activeCitations,
    activeAnnotations,
    activeAiResults,
    activeNote,
    floatingResultId,
    pdfDocument,
    pageImages,
    translationLanguageName,
    ui,
    uiLanguage,
    patchState,
    showToast,
    queueTask,
    goToPage,
    ensureActivePages,
    setIsBusy,
    setActivePanel,
    setFloatingResultId,
    setRightPanelOpen,
  } = input;
  const [linkPreview, setLinkPreview] = useState<LinkPreviewState | null>(null);
  const [linkPreviewLoading, setLinkPreviewLoading] = useState(false);
  async function extractCitationCards() {
    if (!activeDocument) {
      return;
    }
    const cards = extractReferences(activeDocument.id, activePages);
    for (const card of cards) {
      const saved = await upsertCitationCard(card);
      patchState((draft) => {
        draft.citationCards = [saved, ...draft.citationCards.filter((item) => item.id !== saved.id)];
      });
    }
    setActivePanel("citations");
    showToast(cards.length ? `${cards.length}${uiLanguage === "ko" ? "" : " "}${ui.citationCardsExtractedSuffix}` : ui.noReferencesFoundYet);
  }

  async function resolveCitationLinks() {
    if (!activeDocument) {
      return;
    }
    const baseCards = activeCitations.length ? activeCitations : extractReferences(activeDocument.id, activePages);
    if (baseCards.length === 0) {
      showToast(ui.noCitationsForLinks, "error");
      return;
    }
    setIsBusy(true);
    let linked = 0;
    try {
      for (const card of baseCards.slice(0, 30)) {
        const resolved = await resolveCitationLink(card);
        if (resolved.url || resolved.doi) {
          linked += 1;
        }
        const saved = await upsertCitationCard(resolved);
        patchState((draft) => {
          draft.citationCards = [saved, ...draft.citationCards.filter((item) => item.id !== saved.id)];
        });
      }
      setActivePanel("citations");
      showToast(`${linked}${uiLanguage === "ko" ? "" : " "}${ui.citationLinksConnectedSuffix}`);
    } catch (error) {
      showToast(`${ui.citationLinkFailedPrefix}: ${String(error)}`, "error");
    } finally {
      setIsBusy(false);
    }
  }

  async function updateMetadata(field: keyof DocumentRecord, value: string | boolean | null) {
    if (!activeDocument) {
      return;
    }
    const updated = await updateDocument({ ...activeDocument, [field]: value });
    patchState((draft) => {
      draft.documents = draft.documents.map((item) => (item.id === updated.id ? updated : item));
    });
  }

  async function deleteAnnotationById(id: string) {
    const annotation = activeAnnotations.find((item) => item.id === id);
    const linkedResultId = annotation ? explanationResultId(annotation) : "";
    try {
      await deleteAnnotation(id);
      if (linkedResultId) {
        await deleteAiResults([linkedResultId]);
      }
      patchState((draft) => {
        draft.annotations = draft.annotations.filter((item) => item.id !== id);
        if (linkedResultId) {
          draft.aiResults = draft.aiResults.filter((item) => item.id !== linkedResultId);
        }
      });
      if (linkedResultId && floatingResultId === linkedResultId) {
        setFloatingResultId(null);
      }
      if (linkedResultId) {
        showToast(ui.deletedExplanation);
      }
    } catch (error) {
      showToast(`${ui.couldNotDeleteAnnotationPrefix}: ${String(error)}`, "error");
    }
  }

  async function deleteAllActiveAnnotations() {
    if (!activeDocument || activeAnnotations.length === 0) {
      showToast(ui.noHighlightsToDelete);
      return;
    }
    const confirmed = window.confirm(`${ui.deleteAllHighlightsConfirm} (${activeAnnotations.length})`);
    if (!confirmed) {
      return;
    }
    const annotationIds = new Set(activeAnnotations.map((annotation) => annotation.id));
    const linkedResultIds = activeAnnotations.map(explanationResultId).filter(Boolean);
    try {
      await Promise.all(activeAnnotations.map((annotation) => deleteAnnotation(annotation.id)));
      if (linkedResultIds.length > 0) {
        await deleteAiResults(linkedResultIds);
      }
      patchState((draft) => {
        draft.annotations = draft.annotations.filter((annotation) => !annotationIds.has(annotation.id));
        draft.comments = draft.comments.filter((comment) => !annotationIds.has(comment.annotationId));
        draft.settings.autoHighlight = "false";
        if (linkedResultIds.length > 0) {
          const resultIds = new Set(linkedResultIds);
          draft.aiResults = draft.aiResults.filter((result) => !resultIds.has(result.id));
        }
      });
      if (state.settings.autoHighlight === "true") {
        void setSetting("autoHighlight", "false");
      }
      if (floatingResultId && linkedResultIds.includes(floatingResultId)) {
        setFloatingResultId(null);
      }
      showToast(`${annotationIds.size}${uiLanguage === "ko" ? "" : " "}${ui.deletedHighlightsSuffix} ${ui.autoHighlightTurnedOff}`);
    } catch (error) {
      showToast(`${ui.couldNotDeleteHighlightsPrefix}: ${String(error)}`, "error");
    }
  }

  async function deleteExplanationResult(result: AiResultRecord) {
    const linkedAnnotations = activeAnnotations.filter((annotation) => explanationResultId(annotation) === result.id);
    const linkedAnnotationIds = new Set(linkedAnnotations.map((annotation) => annotation.id));
    try {
      await Promise.all(linkedAnnotations.map((annotation) => deleteAnnotation(annotation.id)));
      await deleteAiResults([result.id]);
      patchState((draft) => {
        draft.annotations = draft.annotations.filter((annotation) => !linkedAnnotationIds.has(annotation.id));
        draft.aiResults = draft.aiResults.filter((item) => item.id !== result.id);
      });
      if (floatingResultId === result.id) {
        setFloatingResultId(null);
      }
      showToast(ui.deletedExplanation);
    } catch (error) {
      showToast(`${ui.couldNotDeleteExplanationPrefix}: ${String(error)}`, "error");
    }
  }

  function openExplanation(annotation: AnnotationRecord) {
    const resultId = explanationResultId(annotation);
    const result =
      activeAiResults.find((item) => item.id === resultId) ??
      activeAiResults.find(
        (item) => item.taskType.toString() === "explainText" && normalizeForMatch(item.inputText).includes(normalizeForMatch(annotation.text).slice(0, 120)),
      );
    if (!result) {
      showToast(ui.noSavedExplanation, "error");
      return;
    }
    setFloatingResultId(result.id);
    setRightPanelOpen(true);
    setActivePanel("ai");
  }

  async function openLinkPreview(target: PdfLinkPreviewTarget) {
    if (target.kind === "external" && target.url) {
      const url = target.url;
      const existingSummary = activeAiResults.find(
        (result) => result.taskType.toString() === "externalLinkSummary" && result.inputText.includes(url),
      );
      setLinkPreview({
        kind: "external",
        sourcePage: target.sourcePage,
        title: target.title || hostFromUrl(target.url),
        url,
        summary: existingSummary ? getReadableAiOutput(existingSummary, ui) : externalPreviewSummary(url, ui),
      });
      return;
    }
    if (!pdfDocument) {
      return;
    }
    setLinkPreviewLoading(true);
    try {
      const targetPage = target.targetPage ?? (await resolvePdfDestinationPage(pdfDocument, target.dest));
      if (!targetPage) {
        showToast(ui.previewTargetNotFound, "error");
        return;
      }
      const requiresRegionPreview = isRegionPreviewKind(target.previewKind);
      const regionImageDataUrl = requiresRegionPreview
        ? await renderPdfPageRegionDataUrl(pdfDocument, targetPage, target).catch(() => null)
        : null;
      if (requiresRegionPreview && !regionImageDataUrl) {
        showToast(ui.referencePreviewNotFound, "error");
        return;
      }
      const imageDataUrl = regionImageDataUrl ?? (await renderPdfPageDataUrl(pdfDocument, targetPage, 1.35));
      setLinkPreview({
        kind: "internal",
        sourcePage: target.sourcePage,
        targetPage,
        title: target.previewKind === "link" && target.title === "PDF link" ? `${ui.page} ${targetPage}` : target.title || `${ui.page} ${targetPage}`,
        imageDataUrl,
        previewMode: regionImageDataUrl ? "region" : "page",
        previewKind: target.previewKind,
        targetText: target.targetText,
        excerpt: target.excerpt,
        referenceText: target.referenceText,
      });
    } catch (error) {
      showToast(`${ui.previewFailedPrefix}: ${String(error)}`, "error");
    } finally {
      setLinkPreviewLoading(false);
    }
  }

  function goToLinkPreviewTarget(preview: LinkPreviewState) {
    if (preview.kind === "external") {
      if (!openExternalUrl(preview.url)) {
        showToast(ui.invalidExternalUrl, "error");
      }
      return;
    }
    goToPage(preview.targetPage);
    setLinkPreview(null);
  }

  async function summarizeLinkPreview(preview: LinkPreviewState) {
    if (preview.kind !== "external") {
      return;
    }
    const queued = await queueTask(
      "externalLinkSummary",
      { url: preview.url, reference: preview.url },
      { silent: false, keepPanel: true },
    );
    if (!queued) {
      return;
    }
    setLinkPreview((current) =>
      current?.kind === "external" && current.url === preview.url
        ? { ...current, summary: getReadableAiOutput(queued, ui) }
        : current,
    );
  }

  async function saveNote(markdown: string) {
    if (!activeDocument || !activeNote) {
      return;
    }
    const note = await upsertNote({ ...activeNote, markdown, updatedAt: nowIso() });
    patchState((draft) => {
      draft.notes = [note, ...draft.notes.filter((item) => item.id !== note.id)];
    });
    showToast(ui.noteSaved);
  }

  async function deleteActiveNote() {
    if (!activeNote) {
      return;
    }
    await deleteNote(activeNote.id);
    patchState((draft) => {
      draft.notes = draft.notes.filter((item) => item.id !== activeNote.id);
    });
    showToast(ui.noteDeleted);
  }

  async function exportJson() {
    if (!activeDocument) {
      return;
    }
    const bundle = await exportDocumentJson(activeDocument.id);
    downloadText(`${activeDocument.title || "paper-pilot-export"}.json`, JSON.stringify(bundle, null, 2));
  }

  async function exportZip() {
    if (!activeDocument) {
      return;
    }
    try {
      const path = await exportDocumentZip(activeDocument.id);
      showToast(`${ui.zipExportWrittenPrefix} ${path}`);
    } catch (error) {
      showToast(String(error), "error");
    }
  }

  async function shareAnnotatedFile() {
    if (!activeDocument) {
      showToast(ui.openDocumentFirst, "error");
      return;
    }
    if (!pdfDocument && Object.keys(pageImages).length === 0) {
      showToast(ui.renderPdfFirstForShare, "error");
      return;
    }
    setIsBusy(true);
    try {
      const pages = (await ensureActivePages()).sort((a, b) => a.pageNumber - b.pageNumber);
      const sharePages: SharePdfPage[] = [];
      for (const page of pages) {
        const pageImage =
          pdfDocument ? await renderPdfPageDataUrl(pdfDocument, page.pageNumber) : pageImages[page.pageNumber];
        if (!pageImage) {
          throw new Error(`Page ${page.pageNumber} image is not ready.`);
        }
        sharePages.push(await createTranslatedSharePage(pageImage, page, activeAiResults, translationLanguageName, ui));
      }
      const pdfBytes = buildPdfFromJpegPages(sharePages);
      const fileName = `${safeFileName(activeDocument.title || activeDocument.fileName)}-translated.pdf`;
      if (isTauriRuntime()) {
        const savedPath = await savePdfFile(fileName, pdfBytes);
        if (savedPath) {
          showToast(`${ui.pdfSavedPrefix} ${savedPath}`);
        } else {
          showToast(ui.pdfExportCancelled);
        }
        return;
      }
      const pickerResult = await saveBytesWithBrowserPicker(fileName, pdfBytes, "application/pdf");
      if (pickerResult === "saved") {
        showToast(ui.translatedPdfSaved);
        return;
      }
      if (pickerResult === "cancelled") {
        showToast(ui.pdfExportCancelled);
        return;
      }
      downloadBytes(fileName, pdfBytes, "application/pdf");
      showToast(ui.translatedPdfDownloaded);
    } catch (error) {
      showToast(`${ui.shareFileFailedPrefix}: ${String(error)}`, "error");
    } finally {
      setIsBusy(false);
    }
  }

  return {
    linkPreview,
    linkPreviewLoading,
    setLinkPreview,
    setLinkPreviewLoading,
    extractCitationCards,
    resolveCitationLinks,
    updateMetadata,
    deleteAnnotationById,
    deleteAllActiveAnnotations,
    deleteExplanationResult,
    openExplanation,
    openLinkPreview,
    goToLinkPreviewTarget,
    summarizeLinkPreview,
    saveNote,
    deleteActiveNote,
    exportJson,
    exportZip,
    shareAnnotatedFile,
  };
}
