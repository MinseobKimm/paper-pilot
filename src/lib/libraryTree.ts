import type { DocumentRecord, FolderRecord } from "../types";
import { uiStrings, type UiStrings } from "./uiStrings";

export type FolderTreeRow = {
  folder: FolderRecord;
  depth: number;
  documentCount: number;
  totalDocumentCount: number;
  childCount: number;
};

export function documentFolderId(document: DocumentRecord) {
  return document.folderId || "root";
}

export function folderDisplayName(folder: FolderRecord, ui: UiStrings = uiStrings.ko) {
  return folder.id === "root" ? ui.libraryRoot : folder.name;
}

export function sortedFolderChildren(folders: FolderRecord[], parentId: string | null) {
  return folders
    .filter((folder) => (folder.parentId ?? null) === parentId)
    .sort((a, b) => {
      if (a.id === "root") return -1;
      if (b.id === "root") return 1;
      return folderDisplayName(a).localeCompare(folderDisplayName(b), undefined, { sensitivity: "base" });
    });
}

export function folderDescendantIds(folders: FolderRecord[], folderId: string) {
  const ids = new Set<string>([folderId]);
  const visit = (parentId: string) => {
    for (const child of folders.filter((folder) => folder.parentId === parentId)) {
      if (!ids.has(child.id)) {
        ids.add(child.id);
        visit(child.id);
      }
    }
  };
  visit(folderId);
  return ids;
}

export function folderTreeRows(folders: FolderRecord[], documents: DocumentRecord[]) {
  const directCounts = new Map<string, number>();
  for (const document of documents) {
    const folderId = documentFolderId(document);
    directCounts.set(folderId, (directCounts.get(folderId) ?? 0) + 1);
  }

  const rows: FolderTreeRow[] = [];
  const seen = new Set<string>();
  const pushRows = (parentId: string | null, depth: number) => {
    for (const folder of sortedFolderChildren(folders, parentId)) {
      if (seen.has(folder.id)) {
        continue;
      }
      seen.add(folder.id);
      const descendants = folderDescendantIds(folders, folder.id);
      rows.push({
        folder,
        depth,
        documentCount: directCounts.get(folder.id) ?? 0,
        totalDocumentCount: documents.filter((document) => descendants.has(documentFolderId(document))).length,
        childCount: folders.filter((child) => child.parentId === folder.id).length,
      });
      pushRows(folder.id, depth + 1);
    }
  };

  pushRows(null, 0);
  for (const folder of folders) {
    if (!seen.has(folder.id)) {
      rows.push({
        folder,
        depth: 0,
        documentCount: directCounts.get(folder.id) ?? 0,
        totalDocumentCount: documents.filter((document) => folderDescendantIds(folders, folder.id).has(documentFolderId(document))).length,
        childCount: folders.filter((child) => child.parentId === folder.id).length,
      });
    }
  }
  return rows;
}

export function folderPathLabel(folders: FolderRecord[], folderId: string | null, ui: UiStrings = uiStrings.ko) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const parts: string[] = [];
  const seen = new Set<string>();
  let cursor = folderId || "root";
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = byId.get(cursor);
    if (!folder) {
      break;
    }
    parts.unshift(folderDisplayName(folder, ui));
    cursor = folder.parentId || "";
  }
  return parts.length ? parts.join(" / ") : ui.libraryRoot;
}
