import { useEffect, useMemo, useState } from "react";
import type { AppStateRecord, DocumentRecord, FolderRecord, WorkspaceMode } from "../types";
import { documentFolderId, folderDescendantIds, folderPathLabel } from "../lib/libraryTree";
import { makeId, nowIso } from "../lib/ids";
import { deleteDocument, deleteFolders, updateDocument, upsertFolder } from "../lib/tauri";
import type { PdfDocumentProxy } from "../lib/pdfDocument";
import type { OutlineAnchor, OutlineRow } from "../lib/outlines";
import type { UiStrings } from "../lib/uiStrings";

type PatchState = (mutator: (draft: AppStateRecord) => void) => void;

type LibraryControllerInput = {
  state: AppStateRecord;
  patchState: PatchState;
  ui: UiStrings;
  activeDocument: DocumentRecord | null;
  activeDocumentId: string | null;
  setActiveDocumentId: (id: string | null) => void;
  setPdfDocument: (document: PdfDocumentProxy | null) => void;
  setLoadedBytes: (bytes: Uint8Array | null) => void;
  setPageImages: (images: Record<number, string>) => void;
  setPdfOutlineRows: (rows: OutlineRow[]) => void;
  setPageOutlineAnchors: (anchors: Record<number, OutlineAnchor[]>) => void;
  setActiveOutlineId: (id: string | null) => void;
  setMode: (mode: WorkspaceMode) => void;
  showToast: (message: string, kind?: "info" | "error") => void;
};

export function useLibraryController(input: LibraryControllerInput) {
  const [libraryQuery, setLibraryQuery] = useState("");
  const [folderFilter, setFolderFilter] = useState("root");
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);

  useEffect(() => {
    const existing = new Set(input.state.documents.map((document) => document.id));
    setSelectedDocumentIds((current) => current.filter((id) => existing.has(id)));
  }, [input.state.documents]);

  const filteredDocuments = useMemo(() => {
    const query = libraryQuery.trim().toLowerCase();
    const visibleFolderIds = folderFilter === "all" ? null : folderDescendantIds(input.state.folders, folderFilter);
    return input.state.documents.filter((document) => {
      const inFolder = !visibleFolderIds || visibleFolderIds.has(documentFolderId(document));
      const matches =
        !query ||
        [document.title, document.authors, document.year, document.fileName, document.abstractText]
          .join(" ")
          .toLowerCase()
          .includes(query);
      return inFolder && matches;
    });
  }, [folderFilter, libraryQuery, input.state.documents, input.state.folders]);

  async function createFolder(parentId = folderFilter === "all" ? "root" : folderFilter, nameOverride?: string) {
    const name = (nameOverride ?? newFolderName).trim();
    if (!name) {
      return;
    }
    const folder: FolderRecord = {
      id: makeId("folder"),
      parentId: parentId === "all" ? "root" : parentId,
      name,
      createdAt: nowIso(),
    };
    const saved = await upsertFolder(folder);
    input.patchState((draft) => {
      draft.folders = [saved, ...draft.folders.filter((item) => item.id !== saved.id)];
    });
    setNewFolderName("");
    setFolderFilter(saved.id);
  }

  async function moveActiveDocument(folderId: string) {
    if (!input.activeDocument) {
      return;
    }
    const updated = await updateDocument({ ...input.activeDocument, folderId, updatedAt: nowIso() });
    input.patchState((draft) => {
      draft.documents = draft.documents.map((item) => (item.id === updated.id ? updated : item));
    });
    setFolderFilter(folderId);
  }

  async function renameFolder(folder: FolderRecord) {
    if (folder.id === "root") {
      return;
    }
    const name = window.prompt(input.ui.folderNamePrompt, folder.name)?.trim();
    if (!name || name === folder.name) {
      return;
    }
    const saved = await upsertFolder({ ...folder, name });
    input.patchState((draft) => {
      draft.folders = [saved, ...draft.folders.filter((item) => item.id !== saved.id)];
    });
  }

  async function createChildFolder(parentId: string) {
    const name = window.prompt(input.ui.childFolderNamePrompt)?.trim();
    if (!name) {
      return;
    }
    await createFolder(parentId, name);
  }

  async function deleteFolderTree(folder: FolderRecord) {
    if (folder.id === "root") {
      input.showToast(input.ui.cannotDeleteRootFolder, "error");
      return;
    }
    const ids = folderDescendantIds(input.state.folders, folder.id);
    const targetFolderId = folder.parentId || "root";
    const documentCount = input.state.documents.filter((document) => ids.has(documentFolderId(document))).length;
    const confirmed = window.confirm(
      `"${folder.name}" ${input.ui.deleteFolderConfirm} ${folderPathLabel(input.state.folders, targetFolderId, input.ui)} (${documentCount})`,
    );
    if (!confirmed) {
      return;
    }
    await deleteFolders([...ids], targetFolderId);
    const now = nowIso();
    input.patchState((draft) => {
      draft.folders = draft.folders.filter((item) => !ids.has(item.id));
      draft.documents = draft.documents.map((document) =>
        ids.has(documentFolderId(document))
          ? { ...document, folderId: targetFolderId, updatedAt: now }
          : document,
      );
    });
    setSelectedDocumentIds([]);
    if (ids.has(folderFilter)) {
      setFolderFilter(targetFolderId);
    }
  }

  async function moveDocumentsToFolder(documentIds: string[], folderId: string) {
    const targetFolderId = folderId === "all" ? "root" : folderId;
    const ids = new Set(documentIds);
    const documents = input.state.documents.filter((document) => ids.has(document.id));
    if (documents.length === 0) {
      return;
    }
    const now = nowIso();
    const savedDocuments = await Promise.all(
      documents.map((document) => updateDocument({ ...document, folderId: targetFolderId, updatedAt: now })),
    );
    input.patchState((draft) => {
      draft.documents = draft.documents.map((document) => savedDocuments.find((saved) => saved.id === document.id) ?? document);
    });
    setSelectedDocumentIds([]);
    setFolderFilter(targetFolderId);
  }

  async function deleteDocumentsFromLibrary(documentIds: string[]) {
    const ids = new Set(documentIds);
    if (ids.size === 0) {
      return;
    }
    const confirmed = window.confirm(`${input.ui.deleteDocumentsConfirm} (${ids.size})`);
    if (!confirmed) {
      return;
    }
    for (const id of ids) {
      await deleteDocument(id);
    }
    input.patchState((draft) => {
      draft.documents = draft.documents.filter((item) => !ids.has(item.id));
      draft.pages = draft.pages.filter((item) => !ids.has(item.documentId));
      draft.annotations = draft.annotations.filter((item) => !ids.has(item.documentId));
      draft.comments = draft.comments.filter((item) => !ids.has(item.documentId));
      draft.notes = draft.notes.filter((item) => !ids.has(item.documentId));
      draft.aiResults = draft.aiResults.filter((item) => !ids.has(item.documentId));
      draft.citationCards = draft.citationCards.filter((item) => !ids.has(item.documentId));
    });
    if (input.activeDocumentId && ids.has(input.activeDocumentId)) {
      input.setActiveDocumentId(null);
      input.setPdfDocument(null);
      input.setLoadedBytes(null);
      input.setPageImages({});
      input.setPdfOutlineRows([]);
      input.setPageOutlineAnchors({});
      input.setActiveOutlineId(null);
      input.setMode("library");
    }
    setSelectedDocumentIds([]);
  }

  function toggleLibraryDocumentSelection(id: string, selected: boolean) {
    setSelectedDocumentIds((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return [...next];
    });
  }

  async function toggleDocumentBookmark(document: DocumentRecord) {
    const updated = await updateDocument({ ...document, bookmarked: !document.bookmarked });
    input.patchState((draft) => {
      draft.documents = draft.documents.map((item) => (item.id === updated.id ? updated : item));
    });
  }

  return {
    libraryQuery,
    setLibraryQuery,
    folderFilter,
    setFolderFilter,
    newFolderName,
    setNewFolderName,
    selectedDocumentIds,
    setSelectedDocumentIds,
    filteredDocuments,
    createFolder,
    moveActiveDocument,
    renameFolder,
    createChildFolder,
    deleteFolderTree,
    moveDocumentsToFolder,
    deleteDocumentsFromLibrary,
    toggleLibraryDocumentSelection,
    toggleDocumentBookmark,
  };
}
