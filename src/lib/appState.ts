import type { AppStateRecord, NoteRecord } from "../types";
import { nowIso } from "./ids";
import { wordMeaningLookupEnabledSettingKey } from "./wordMeanings";

export const initialState: AppStateRecord = {
  folders: [{ id: "root", parentId: null, name: "Library", createdAt: nowIso() }],
  documents: [],
  pages: [],
  annotations: [],
  comments: [],
  notes: [],
  aiResults: [],
  citationCards: [],
  recommendationRuns: [],
  settings: {
    language: "ko",
    uiLanguage: "ko",
    translationLanguage: "ko",
    theme: "light",
    fontScale: "1",
    mathDelimiter: "$$",
    autoTranslate: "true",
    autoTranslateAutostartMigrated: "true",
    autoHighlight: "false",
    aiProvider: "codex-cli",
    aiModel: "",
    codexModel: "",
    codexReasoningEffort: "",
    claudeModel: "",
    bridgePath: "bridge",
    customPrompt: "",
    readerOutlineOpen: "true",
    readerOutlineCompact: "false",
    readerTranslationPanelOpen: "false",
    readerRightPanelOpen: "true",
    readerOutlineWidth: "220",
    readerTranslationWidth: "360",
    readerRightPanelWidth: "340",
    wordMeaningLookupEnabled: "true",
    wordMeaningMapJson: "{}",
    onlineDictionaryCacheJson: "{}",
  },
};

export function wordMeaningLookupEnabled(settings: Record<string, string>) {
  return settings[wordMeaningLookupEnabledSettingKey] !== "false";
}


export function documentPages(state: AppStateRecord, documentId: string) {
  return state.pages
    .filter((page) => page.documentId === documentId)
    .sort((a, b) => a.pageNumber - b.pageNumber);
}

export function currentNote(state: AppStateRecord, documentId: string): NoteRecord {
  return (
    state.notes.find((note) => note.documentId === documentId) ?? {
      id: `note-${documentId}`,
      documentId,
      markdown: "",
      updatedAt: nowIso(),
    }
  );
}

export function inferYear(value = ""): string {
  const match = value.match(/(19|20)\d{2}/);
  return match?.[0] ?? "";
}
