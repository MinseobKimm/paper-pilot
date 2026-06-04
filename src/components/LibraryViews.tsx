import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from "react";
import { Archive, BookOpen, Bookmark, BookmarkCheck, ChevronLeft, ChevronRight, FileText, FolderOpen, FolderPlus, Grid2X2, List, PenLine, Search, Trash2, Upload, X } from "./icons";
import type { AppStateRecord, DocumentRecord, FolderRecord, NoteRecord } from "../types";
import { documentFolderId, folderDescendantIds, folderDisplayName, folderPathLabel, folderTreeRows, sortedFolderChildren } from "../lib/libraryTree";
import { readingStatusFromSettings, readingStatusOption, readingStatusOptions, type ReadingStatus } from "../lib/readingStatus";
import { useUiStrings } from "../lib/uiStrings";

const graphViewportWidth = 1040;
const graphViewportHeight = 640;
const graphBaseSceneWidth = 980;
const graphBaseSceneHeight = 640;
const graphMinZoom = 0.45;
const graphMaxZoom = 2.4;
const graphLabelLineHeight = 16;

type LibraryGraphNode = {
  id: string;
  kind: "folder" | "document";
  label: string;
  depth: number;
  x: number;
  y: number;
  r: number;
  count: number;
  folder?: FolderRecord;
  document?: DocumentRecord;
};

type LibraryGraphLink = {
  id: string;
  source: LibraryGraphNode;
  target: LibraryGraphNode;
};

function stableNumber(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function folderDepthFromRoot(foldersById: Map<string, FolderRecord>, folderId: string, rootId: string) {
  if (folderId === rootId) {
    return 0;
  }
  let depth = 0;
  let cursor = folderId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = foldersById.get(cursor);
    if (!folder) {
      break;
    }
    depth += 1;
    if ((folder.parentId || "root") === rootId) {
      return depth;
    }
    cursor = folder.parentId || "root";
  }
  return depth;
}

function ancestorFolderIds(foldersById: Map<string, FolderRecord>, folderId: string, stopId: string) {
  const ids: string[] = [];
  let cursor = folderId || "root";
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    ids.push(cursor);
    if (cursor === stopId) {
      break;
    }
    const folder = foldersById.get(cursor);
    cursor = folder?.parentId || "root";
  }
  if (!ids.includes(stopId)) {
    ids.push(stopId);
  }
  return ids;
}

function wordChunks(value: string, lineLength: number) {
  if (value.length <= lineLength) {
    return [value];
  }
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += lineLength) {
    chunks.push(value.slice(index, index + lineLength));
  }
  return chunks;
}

function wrappedSvgLines(value: string, lineLength: number, maxLines = Number.POSITIVE_INFINITY) {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    for (const chunk of wordChunks(word, lineLength)) {
      const next = current ? `${current} ${chunk}` : chunk;
      if (next.length > lineLength && current) {
        lines.push(current);
        current = chunk;
        if (lines.length === maxLines) {
          break;
        }
      } else {
        current = next;
      }
    }
    if (lines.length === maxLines) {
      break;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  if (Number.isFinite(maxLines) && lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/[.,:;]$/, "").slice(0, lineLength - 1)}...`;
  }
  return lines.length ? lines : [value.slice(0, lineLength)];
}

function graphLabelWidth(lines: string[], minWidth: number, maxWidth: number) {
  const widestLine = Math.max(...lines.map((line) => line.length), 1);
  return Math.round(clampNumber(38 + widestLine * 7.2, minWidth, maxWidth));
}

function graphNodeLabelMetrics(node: LibraryGraphNode) {
  if (node.kind === "folder") {
    const lines = wrappedSvgLines(node.label, 24);
    const width = graphLabelWidth(lines, 150, 280);
    const y = node.r + 22;
    const height = lines.length * graphLabelLineHeight + 22;
    return { lines, width, y, height };
  }
  const lines = wrappedSvgLines(node.label, 34);
  const width = graphLabelWidth(lines, 220, 380);
  const y = node.r + 22;
  const height = lines.length * graphLabelLineHeight + 38;
  return { lines, width, y, height };
}

function graphContentBounds(graph: ReturnType<typeof buildLibraryGraph>) {
  if (graph.nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: graph.sceneWidth, maxY: graph.sceneHeight };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of graph.nodes) {
    const metrics = graphNodeLabelMetrics(node);
    const nodeMinX = node.x - Math.max(node.r + 12, metrics.width / 2);
    const nodeMaxX = node.x + Math.max(node.r + 12, metrics.width / 2);
    const nodeMinY = node.y - node.r - 12;
    const nodeMaxY = node.y + metrics.y + metrics.height;
    minX = Math.min(minX, nodeMinX);
    minY = Math.min(minY, nodeMinY);
    maxX = Math.max(maxX, nodeMaxX);
    maxY = Math.max(maxY, nodeMaxY);
  }
  return { minX, minY, maxX, maxY };
}

function graphFitView(graph: ReturnType<typeof buildLibraryGraph>) {
  const bounds = graphContentBounds(graph);
  const padding = 72;
  const width = Math.max(1, bounds.maxX - bounds.minX + padding * 2);
  const height = Math.max(1, bounds.maxY - bounds.minY + padding * 2);
  const nextZoom = clampNumber(Math.min(graphViewportWidth / width, graphViewportHeight / height), graphMinZoom, graphMaxZoom);
  return {
    zoom: nextZoom,
    x: (graphViewportWidth - (bounds.minX + bounds.maxX) * nextZoom) / 2,
    y: (graphViewportHeight - (bounds.minY + bounds.maxY) * nextZoom) / 2,
  };
}

function buildLibraryGraph(
  folders: FolderRecord[],
  allDocuments: DocumentRecord[],
  graphDocuments: DocumentRecord[],
  ui: ReturnType<typeof useUiStrings>,
  rootFolderId = "root",
) {
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const rootFolder = foldersById.get(rootFolderId) ?? foldersById.get("root") ?? folders[0];
  if (!rootFolder) {
    return {
      nodes: [] as LibraryGraphNode[],
      links: [] as LibraryGraphLink[],
      sceneWidth: graphBaseSceneWidth,
      sceneHeight: graphBaseSceneHeight,
    };
  }

  const includedFolderIds = new Set<string>([rootFolder.id]);
  for (const document of graphDocuments) {
    for (const ancestorId of ancestorFolderIds(foldersById, documentFolderId(document), rootFolder.id)) {
      if (foldersById.has(ancestorId)) {
        includedFolderIds.add(ancestorId);
      }
    }
  }

  const nodes: LibraryGraphNode[] = [];
  const folderNodes = [...includedFolderIds]
    .map((id) => foldersById.get(id))
    .filter((folder): folder is FolderRecord => Boolean(folder))
    .sort((a, b) => {
      const depthDiff = folderDepthFromRoot(foldersById, a.id, rootFolder.id) - folderDepthFromRoot(foldersById, b.id, rootFolder.id);
      if (depthDiff !== 0) {
        return depthDiff;
      }
      return folderDisplayName(a, ui).localeCompare(folderDisplayName(b, ui), undefined, { sensitivity: "base" });
    });

  for (const folder of folderNodes) {
    const descendants = folderDescendantIds(folders, folder.id);
    const count = allDocuments.filter((document) => descendants.has(documentFolderId(document))).length;
    const depth = folderDepthFromRoot(foldersById, folder.id, rootFolder.id);
    nodes.push({
      id: `folder:${folder.id}`,
      kind: "folder",
      label: folderDisplayName(folder, ui),
      depth,
      x: 0,
      y: 0,
      r: clampNumber(42 - depth * 5 + Math.min(8, Math.sqrt(count) * 2), 24, 48),
      count,
      folder,
    });
  }

  for (const document of graphDocuments) {
    const folderId = documentFolderId(document);
    nodes.push({
      id: `document:${document.id}`,
      kind: "document",
      label: document.title || document.fileName,
      depth: folderDepthFromRoot(foldersById, folderId, rootFolder.id) + 1,
      x: 0,
      y: 0,
      r: document.bookmarked ? 12 : 10,
      count: 0,
      document,
    });
  }

  const maxDepth = Math.max(1, ...nodes.map((node) => node.depth));
  const levels = new Map<number, LibraryGraphNode[]>();
  for (const node of nodes) {
    const level = levels.get(node.depth) ?? [];
    level.push(node);
    levels.set(node.depth, level);
  }

  const maxLevelSize = Math.max(1, ...[...levels.values()].map((level) => level.length));
  const maxLabelLines = Math.max(
    1,
    ...nodes.map((node) => wrappedSvgLines(node.label, node.kind === "document" ? 34 : 24).length),
  );
  const verticalNodeGap = clampNumber(88 + maxLabelLines * graphLabelLineHeight + 38, 146, 270);
  const sceneWidth = Math.max(graphBaseSceneWidth, 360 + maxDepth * 430);
  const sceneHeight = Math.max(graphBaseSceneHeight, 220 + maxLevelSize * verticalNodeGap);

  for (const [depth, levelNodes] of levels) {
    levelNodes.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
    for (const [index, node] of levelNodes.entries()) {
      const spread = sceneHeight - 180;
      const y = 90 + ((index + 1) / (levelNodes.length + 1)) * spread;
      const jitter = (stableNumber(node.id) % 31) - 15;
      node.x = 110 + (depth / maxDepth) * (sceneWidth - 300);
      node.y = clampNumber(y + jitter, 90, sceneHeight - 160);
    }
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const links: LibraryGraphLink[] = [];
  for (const node of nodes) {
    if (node.kind === "folder" && node.folder) {
      const parentId = node.folder.id === rootFolder.id ? "" : node.folder.parentId || "root";
      const source = nodeById.get(`folder:${parentId}`);
      if (source) {
        links.push({ id: `${source.id}->${node.id}`, source, target: node });
      }
    }
    if (node.kind === "document" && node.document) {
      const source = nodeById.get(`folder:${documentFolderId(node.document)}`) ?? nodeById.get(`folder:${rootFolder.id}`);
      if (source) {
        links.push({ id: `${source.id}->${node.id}`, source, target: node });
      }
    }
  }

  return { nodes, links, sceneWidth, sceneHeight };
}

function folderSidebarWidth(rows: ReturnType<typeof folderTreeRows>, ui: ReturnType<typeof useUiStrings>) {
  const widest = rows.reduce((max, row) => {
    const label = folderDisplayName(row.folder, ui);
    return Math.max(max, 136 + row.depth * 16 + Math.min(38, label.length) * 6.8);
  }, 280);
  return Math.round(clampNumber(widest, 280, 430));
}

function folderBreadcrumbs(folders: FolderRecord[], folderId: string, ui: ReturnType<typeof useUiStrings>) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const rootFolder = byId.get("root");
  const crumbs: FolderRecord[] = [];
  const seen = new Set<string>();
  let cursor = folderId || "root";
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const folder = byId.get(cursor);
    if (!folder) {
      break;
    }
    crumbs.unshift(folder);
    if (folder.id === "root") {
      break;
    }
    cursor = folder.parentId || "root";
  }
  if (crumbs.length === 0 && rootFolder) {
    crumbs.push(rootFolder);
  }
  return crumbs.map((folder) => ({
    folder,
    label: folderDisplayName(folder, ui),
  }));
}

function folderNameMatchesQuery(folder: FolderRecord, folders: FolderRecord[], query: string, ui: ReturnType<typeof useUiStrings>) {
  const searchable = `${folderDisplayName(folder, ui)} ${folderPathLabel(folders, folder.id, ui)}`.toLowerCase();
  return searchable.includes(query);
}

type LibraryDisplayMode = "browser" | "graph";
type LibraryViewProps = {
  state: AppStateRecord;
  documents: DocumentRecord[];
  libraryQuery: string;
  folderFilter: string;
  newFolderName: string;
  onLibraryQuery: (value: string) => void;
  onFolderFilter: (value: string) => void;
  onNewFolderName: (value: string) => void;
  onCreateFolder: () => void;
  onPickFile: () => void;
  onOpen: (document: DocumentRecord) => void;
  onSelect: (id: string) => void;
  onToggleBookmark: (document: DocumentRecord) => void;
};

export function LibraryView(props: LibraryViewProps) {
  const ui = useUiStrings();
  return (
    <section className="library-view">
      <div className="library-sidebar">
        <div className="upload-target" onClick={props.onPickFile} role="button" tabIndex={0}>
          <Upload size={26} />
          <strong>{ui.addPdf}</strong>
          <span>{ui.addPdfDrop}</span>
        </div>
        <div className="folder-tools">
          <div className="inline-input">
            <input
              value={props.newFolderName}
              onChange={(event) => props.onNewFolderName(event.target.value)}
              placeholder={ui.newFolder}
            />
            <button title={ui.createFolder} className="icon-button" onClick={props.onCreateFolder}>
              <FolderPlus size={17} />
            </button>
          </div>
          <button
            className={props.folderFilter === "all" ? "folder-row active" : "folder-row"}
            onClick={() => props.onFolderFilter("all")}
          >
            <Archive size={16} />
            <span className="folder-label">{ui.allDocuments}</span>
          </button>
          {props.state.folders.map((folder) => (
            <button
              key={folder.id}
              className={props.folderFilter === folder.id ? "folder-row active" : "folder-row"}
              onClick={() => props.onFolderFilter(folder.id)}
            >
              <FolderOpen size={16} />
              <span className="folder-label">{folderDisplayName(folder, ui)}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="library-main">
        <div className="library-controls">
          <div className="search-box wide">
            <Search size={16} />
            <input
              value={props.libraryQuery}
              onChange={(event) => props.onLibraryQuery(event.target.value)}
              placeholder={ui.librarySearchPlaceholder}
            />
          </div>
          <span className="muted">{props.documents.length} {ui.documentsSuffix}</span>
        </div>
        <div className="document-grid">
          {props.documents.map((document) => (
            <article
              key={document.id}
              className="document-card"
              title={document.title || document.fileName}
              onClick={() => props.onSelect(document.id)}
              onDoubleClick={() => props.onOpen(document)}
            >
              <div className="document-card-head">
                <FileText size={20} />
                <button
                  className="bookmark-button"
                  title={document.bookmarked ? ui.removeBookmark : ui.bookmark}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onToggleBookmark(document);
                  }}
                >
                  {document.bookmarked ? <BookmarkCheck size={18} /> : <Bookmark size={18} />}
                </button>
              </div>
              <h3>{document.title || document.fileName}</h3>
              <p>{document.authors || ui.noAuthors}</p>
              <div className="document-meta">
                <span>{document.year || ui.unknownYear}</span>
                <span>{document.pageCount || "-"}{ui.pageSuffix}</span>
              </div>
              <button
                className="wide-command compact"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onOpen(document);
                }}
              >
                <BookOpen size={16} />
                <span>{ui.open}</span>
              </button>
            </article>
          ))}
          {props.documents.length === 0 && (
            <div className="empty-list">
              <Upload size={30} />
              <strong>{ui.noPdfInView}</strong>
              <span>{ui.addPdfOrChooseFolder}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

type LibraryManagerViewProps = {
  state: AppStateRecord;
  documents: DocumentRecord[];
  libraryQuery: string;
  folderFilter: string;
  newFolderName: string;
  selectedDocumentIds: string[];
  notes: NoteRecord[];
  onLibraryQuery: (value: string) => void;
  onFolderFilter: (value: string) => void;
  onNewFolderName: (value: string) => void;
  onCreateFolder: (parentId?: string, name?: string) => void;
  onCreateChildFolder: (parentId: string) => void;
  onRenameFolder: (folder: FolderRecord) => void;
  onDeleteFolder: (folder: FolderRecord) => void;
  onPickFile: () => void;
  onOpen: (document: DocumentRecord) => void;
  onSelect: (id: string) => void;
  onToggleSelect: (id: string, selected: boolean) => void;
  onSelectVisible: (ids: string[]) => void;
  onMoveDocuments: (ids: string[], folderId: string) => void;
  onDeleteDocuments: (ids: string[]) => void;
  onToggleBookmark: (document: DocumentRecord) => void;
  onRenameDocument: (document: DocumentRecord) => void;
  onSaveDocumentDetails: (document: DocumentRecord, markdown: string, status: ReadingStatus) => Promise<void>;
};

export function LibraryManagerView(props: LibraryManagerViewProps) {
  const ui = useUiStrings();
  const [displayMode, setDisplayMode] = useState<LibraryDisplayMode>("browser");
  const [inspectedDocument, setInspectedDocument] = useState<DocumentRecord | null>(null);
  const folderRows = folderTreeRows(props.state.folders, props.state.documents);
  const folderStats = useMemo(() => new Map(folderRows.map((row) => [row.folder.id, row])), [folderRows]);
  const folderOptions = folderRows.map((row) => ({
    id: row.folder.id,
    label: `${"  ".repeat(row.depth)}${folderDisplayName(row.folder, ui)}`,
  }));
  const currentFolderId = props.folderFilter === "all" ? "root" : props.folderFilter;
  const currentFolder = props.state.folders.find((folder) => folder.id === currentFolderId) ?? props.state.folders.find((folder) => folder.id === "root") ?? null;
  const currentFolderLabel = currentFolder ? folderPathLabel(props.state.folders, currentFolder.id, ui) : ui.libraryRoot;
  const currentParentId = currentFolderId;
  const sidebarWidth = useMemo(() => folderSidebarWidth(folderRows, ui), [folderRows, ui]);
  const queryActive = props.libraryQuery.trim().length > 0;
  const query = props.libraryQuery.trim().toLowerCase();
  const currentScopeIds = useMemo(() => folderDescendantIds(props.state.folders, currentFolderId), [currentFolderId, props.state.folders]);
  const directFolders = useMemo(() => sortedFolderChildren(props.state.folders, currentFolderId), [currentFolderId, props.state.folders]);
  const browserFolders = useMemo(() => {
    if (!queryActive) {
      return directFolders;
    }
    return props.state.folders
      .filter((folder) => folder.id !== currentFolderId && currentScopeIds.has(folder.id) && folderNameMatchesQuery(folder, props.state.folders, query, ui))
      .sort((a, b) => folderPathLabel(props.state.folders, a.id, ui).localeCompare(folderPathLabel(props.state.folders, b.id, ui), undefined, { sensitivity: "base" }));
  }, [currentFolderId, currentScopeIds, directFolders, props.state.folders, query, queryActive, ui]);
  const browserDocuments = useMemo(() => {
    if (queryActive) {
      return props.documents;
    }
    if (currentFolderId === "root") {
      return [];
    }
    return props.state.documents.filter((document) => documentFolderId(document) === currentFolderId);
  }, [currentFolderId, props.documents, props.state.documents, queryActive]);
  const graphDocuments = props.documents;
  const visibleDocuments = displayMode === "browser" ? browserDocuments : graphDocuments;
  const selectedSet = new Set(props.selectedDocumentIds);
  const visibleIds = visibleDocuments.map((document) => document.id);
  const visibleIdSet = new Set(visibleIds);
  const selectedVisibleIds = props.selectedDocumentIds.filter((id) => visibleIdSet.has(id));
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
  const breadcrumbs = useMemo(() => folderBreadcrumbs(props.state.folders, currentFolderId, ui), [currentFolderId, props.state.folders, ui]);
  const parentFolderId = currentFolder?.id === "root" ? "root" : currentFolder?.parentId || "root";
  const graph = useMemo(
    () =>
      buildLibraryGraph(
        props.state.folders,
        props.state.documents,
        graphDocuments,
        ui,
        currentFolderId,
      ),
    [currentFolderId, graphDocuments, props.state.documents, props.state.folders, ui],
  );

  return (
    <section className="library-view" style={{ "--library-sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <div className="library-sidebar">
        <div className="upload-target" onClick={props.onPickFile} role="button" tabIndex={0}>
          <Upload size={26} />
          <strong>{ui.addPdf}</strong>
          <span>{ui.addPdfToSelectedFolder}</span>
        </div>
        <div className="folder-tools">
          <div className="folder-tools-head">
            <strong>{ui.folders}</strong>
            <button title={ui.createUnderCurrentFolder} className="icon-button" onClick={() => props.onCreateFolder(currentParentId)}>
              <FolderPlus size={16} />
            </button>
          </div>
          <div className="inline-input">
            <input
              value={props.newFolderName}
              onChange={(event) => props.onNewFolderName(event.target.value)}
              placeholder={ui.newFolder}
            />
            <button title={ui.createFolder} className="icon-button" onClick={() => props.onCreateFolder(currentParentId)}>
              <FolderPlus size={17} />
            </button>
          </div>
          <button
            className={currentFolderId === "root" ? "folder-row active" : "folder-row"}
            onClick={() => props.onFolderFilter("root")}
          >
            <Archive size={16} />
            <span className="folder-label">{ui.libraryRoot}</span>
          </button>
          <div className="folder-tree">
            {folderRows.filter((row) => row.folder.id !== "root").map((row) => (
              <div
                key={row.folder.id}
                className="folder-tree-row"
                data-folder-id={row.folder.id}
                style={{ "--folder-depth": Math.max(0, row.depth - 1) } as CSSProperties}
              >
                <button
                  className={props.folderFilter === row.folder.id ? "folder-row active" : "folder-row"}
                  onClick={() => props.onFolderFilter(row.folder.id)}
                  title={folderPathLabel(props.state.folders, row.folder.id, ui)}
                >
                  {row.childCount > 0 ? <ChevronRight size={13} /> : <span className="folder-row-spacer" />}
                  <FolderOpen size={16} />
                  <span className="folder-label">{folderDisplayName(row.folder, ui)}</span>
                  </button>
                <div className="folder-row-actions">
                  <button data-folder-action="create-child" title={ui.createChildFolder} onClick={() => props.onCreateChildFolder(row.folder.id)}>
                    <FolderPlus size={13} />
                  </button>
                  {row.folder.id !== "root" && (
                    <button data-folder-action="rename" title={ui.rename} onClick={() => props.onRenameFolder(row.folder)}>
                      <PenLine size={13} />
                    </button>
                  )}
                  {row.folder.id !== "root" && (
                    <button data-folder-action="delete" title={ui.deleteFolder} onClick={() => props.onDeleteFolder(row.folder)}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="library-main library-manager-main">
        <div className="library-controls library-manager-controls">
          <div className="search-box wide">
            <Search size={16} />
            <input
              value={props.libraryQuery}
              onChange={(event) => props.onLibraryQuery(event.target.value)}
              placeholder={ui.librarySearchPlaceholder}
            />
          </div>
          <div className="library-view-toggle" role="tablist" aria-label="Library view mode">
            <button
              className={displayMode === "browser" ? "active" : ""}
              role="tab"
              aria-selected={displayMode === "browser"}
              onClick={() => setDisplayMode("browser")}
            >
              <List size={15} />
              <span>문서 보기</span>
            </button>
            <button
              className={displayMode === "graph" ? "active" : ""}
              role="tab"
              aria-selected={displayMode === "graph"}
              onClick={() => setDisplayMode("graph")}
            >
              <Grid2X2 size={15} />
              <span>그래프</span>
            </button>
          </div>
          <span className="muted">{currentFolderLabel} · {props.documents.length} {ui.papersSuffix}</span>
        </div>
        <div className="library-address-bar">
          <button className="icon-button" title="상위 폴더" disabled={currentFolderId === "root"} onClick={() => props.onFolderFilter(parentFolderId)}>
            <ChevronLeft size={16} />
          </button>
          <div className="library-address-path" aria-label="Folder address">
            {breadcrumbs.map((crumb, index) => (
              <span key={crumb.folder.id} className="address-crumb-wrap">
                {index > 0 && <ChevronRight className="address-separator" size={13} />}
                <button
                  className={index === breadcrumbs.length - 1 ? "address-crumb active" : "address-crumb"}
                  onClick={() => props.onFolderFilter(crumb.folder.id)}
                >
                  {index === 0 && <Archive size={14} />}
                  <span>{crumb.label}</span>
                </button>
              </span>
            ))}
          </div>
        </div>
        <div className="library-bulk-bar">
          <label>
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={(event) => {
                const next = event.target.checked
                  ? [...new Set([...props.selectedDocumentIds, ...visibleIds])]
                  : props.selectedDocumentIds.filter((id) => !visibleIdSet.has(id));
                props.onSelectVisible(next);
              }}
            />
            <span>{selectedVisibleIds.length ? `${selectedVisibleIds.length} ${ui.selectedSuffix}` : ui.currentListSelect}</span>
          </label>
          <select
            aria-label={ui.moveSelectedPapers}
            defaultValue=""
            disabled={props.selectedDocumentIds.length === 0}
            onChange={(event) => {
              const folderId = event.currentTarget.value;
              event.currentTarget.value = "";
              if (folderId) {
                props.onMoveDocuments(props.selectedDocumentIds, folderId);
              }
            }}
          >
            <option value="">{ui.moveSelectedPapersPlaceholder}</option>
            {folderOptions.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.label}
              </option>
            ))}
          </select>
          <button className="icon-button with-label danger" disabled={props.selectedDocumentIds.length === 0} onClick={() => props.onDeleteDocuments(props.selectedDocumentIds)}>
            <Trash2 size={15} />
            <span>{ui.delete}</span>
          </button>
        </div>
        {displayMode === "browser" ? (
          <LibraryExplorerView
            folders={browserFolders}
            documents={browserDocuments}
            foldersById={props.state.folders}
            folderStats={folderStats}
            settings={props.state.settings}
            selectedDocumentIds={selectedSet}
            queryActive={queryActive}
            currentFolderId={currentFolderId}
            onFolder={(folder) => props.onFolderFilter(folder.id)}
            onDocument={(document) => {
              props.onSelect(document.id);
              setInspectedDocument(document);
            }}
            onToggleSelect={props.onToggleSelect}
            onOpen={(document) => props.onOpen(document)}
            onToggleBookmark={props.onToggleBookmark}
          />
        ) : graphDocuments.length === 0 ? (
          <div className="library-graph-shell">
            <div className="empty-list">
              <Upload size={30} />
              <strong>{ui.noPaperInView}</strong>
              <span>{ui.addPdfOrChooseFolder}</span>
            </div>
          </div>
        ) : (
          <LibraryGraph
            graph={graph}
            selectedDocumentIds={selectedSet}
            settings={props.state.settings}
            notes={props.notes}
            folderPath={(folderId) => folderPathLabel(props.state.folders, folderId, ui)}
            onFolder={(folder) => props.onFolderFilter(folder.id)}
            onDocument={(document) => {
              props.onSelect(document.id);
              props.onOpen(document);
            }}
            onSaveDocumentDetails={props.onSaveDocumentDetails}
          />
        )}
        {inspectedDocument && (
          <DocumentGraphModal
            document={inspectedDocument}
            note={props.notes.find((note) => note.documentId === inspectedDocument.id) ?? null}
            status={readingStatusFromSettings(props.state.settings, inspectedDocument.id)}
            onClose={() => setInspectedDocument(null)}
            onOpen={() => {
              props.onOpen(inspectedDocument);
              setInspectedDocument(null);
            }}
            onSave={async (markdown, status) => {
              await props.onSaveDocumentDetails(inspectedDocument, markdown, status);
              setInspectedDocument((current) => (current?.id === inspectedDocument.id ? { ...current } : current));
            }}
          />
        )}
      </div>
    </section>
  );
}

function LibraryExplorerView(props: {
  folders: FolderRecord[];
  documents: DocumentRecord[];
  foldersById: FolderRecord[];
  folderStats: Map<string, ReturnType<typeof folderTreeRows>[number]>;
  settings: Record<string, string>;
  selectedDocumentIds: Set<string>;
  queryActive: boolean;
  currentFolderId: string;
  onFolder: (folder: FolderRecord) => void;
  onDocument: (document: DocumentRecord) => void;
  onToggleSelect: (id: string, selected: boolean) => void;
  onOpen: (document: DocumentRecord) => void;
  onToggleBookmark: (document: DocumentRecord) => void;
}) {
  const ui = useUiStrings();
  const isEmpty = props.folders.length === 0 && props.documents.length === 0;

  return (
    <div className="library-explorer-shell">
      {props.folders.length > 0 && (
        <section className="library-explorer-section">
          <div className="library-section-head">
            <strong>{props.queryActive ? "검색된 폴더" : "폴더"}</strong>
            <span>{props.folders.length}</span>
          </div>
          <div className="library-folder-grid">
            {props.folders.map((folder) => {
              const stats = props.folderStats.get(folder.id);
              return (
                <button
                  key={folder.id}
                  className="library-folder-tile"
                  title={folderPathLabel(props.foldersById, folder.id, ui)}
                  onClick={() => props.onFolder(folder)}
                >
                  <span className="folder-tile-icon">
                    <FolderOpen size={28} />
                  </span>
                  <span className="folder-tile-copy">
                    <strong>{folderDisplayName(folder, ui)}</strong>
                    <small>
                      {(stats?.totalDocumentCount ?? 0)} {ui.papersSuffix}
                      {(stats?.childCount ?? 0) > 0 ? ` · ${stats?.childCount ?? 0} 하위 폴더` : ""}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {props.documents.length > 0 && (
        <section className="library-explorer-section">
          <div className="library-section-head">
            <strong>{props.queryActive ? "검색된 논문" : "논문"}</strong>
            <span>{props.documents.length}</span>
          </div>
          <div className="library-file-table">
            {props.documents.map((document) => {
              const selected = props.selectedDocumentIds.has(document.id);
              const status = readingStatusOption(readingStatusFromSettings(props.settings, document.id));
              return (
                <article
                  key={document.id}
                  className={selected ? "library-file-row selected" : "library-file-row"}
                  title={document.title || document.fileName}
                  onClick={() => props.onDocument(document)}
                >
                  <label className="file-select" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(event) => props.onToggleSelect(document.id, event.currentTarget.checked)}
                    />
                  </label>
                  <FileText className="file-kind-icon" size={19} />
                  <div className="file-main">
                    <strong className="file-title">{document.title || document.fileName}</strong>
                    <span className="file-subtitle">
                      {document.authors || ui.noAuthors}
                      {props.queryActive ? ` · ${folderPathLabel(props.foldersById, documentFolderId(document), ui)}` : ""}
                    </span>
                  </div>
                  <span
                    className="file-status-chip"
                    style={{ "--reading-status-color": status.color, "--reading-status-bg": status.background } as CSSProperties}
                  >
                    {status.label}
                  </span>
                  <span className="file-year">{document.year || ui.unknownYear}</span>
                  <span className="file-pages">{document.pageCount || "-"}{ui.pageSuffix}</span>
                  <div className="library-file-actions">
                    <button
                      className="icon-button"
                      title={document.bookmarked ? ui.removeBookmark : ui.bookmark}
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onToggleBookmark(document);
                      }}
                    >
                      {document.bookmarked ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
                    </button>
                    <button
                      className="icon-button"
                      title={ui.open}
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onOpen(document);
                      }}
                    >
                      <BookOpen size={16} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {isEmpty && (
        <div className="empty-list explorer-empty">
          <FolderOpen size={30} />
          <strong>{props.currentFolderId === "root" && !props.queryActive ? "폴더가 없습니다" : ui.noPaperInView}</strong>
          <span>{ui.addPdfOrChooseFolder}</span>
        </div>
      )}
    </div>
  );
}

function LibraryGraph(props: {
  graph: ReturnType<typeof buildLibraryGraph>;
  selectedDocumentIds: Set<string>;
  settings: Record<string, string>;
  notes: NoteRecord[];
  folderPath: (folderId: string) => string;
  onFolder: (folder: FolderRecord) => void;
  onDocument: (document: DocumentRecord) => void;
  onSaveDocumentDetails: (document: DocumentRecord, markdown: string, status: ReadingStatus) => Promise<void>;
}) {
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [inspectedDocument, setInspectedDocument] = useState<DocumentRecord | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);

  function clampPan(nextX: number, nextY: number, zoomLevel = zoom) {
    const scaledWidth = props.graph.sceneWidth * zoomLevel;
    const scaledHeight = props.graph.sceneHeight * zoomLevel;
    return {
      x: clampNumber(nextX, graphViewportWidth - scaledWidth - 120, 120),
      y: clampNumber(nextY, graphViewportHeight - scaledHeight - 120, 120),
    };
  }

  function pointerDelta(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - (dragRef.current?.startX ?? event.clientX)) / Math.max(1, rect.width)) * graphViewportWidth,
      y: ((event.clientY - (dragRef.current?.startY ?? event.clientY)) / Math.max(1, rect.height)) * graphViewportHeight,
    };
  }

  function startPan(event: PointerEvent<SVGSVGElement>) {
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
  }

  function movePan(event: PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const delta = pointerDelta(event);
    setPan(clampPan(drag.panX + delta.x, drag.panY + delta.y));
  }

  function viewportPoint(event: WheelEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / Math.max(1, rect.width)) * graphViewportWidth,
      y: ((event.clientY - rect.top) / Math.max(1, rect.height)) * graphViewportHeight,
    };
  }

  function zoomGraph(event: WheelEvent<SVGSVGElement>) {
    event.preventDefault();
    const delta = event.deltaMode === 1
      ? event.deltaY * 16
      : event.deltaMode === 2
        ? event.deltaY * graphViewportHeight
        : event.deltaY;
    const nextZoom = clampNumber(zoom * Math.exp(-delta * 0.0013), graphMinZoom, graphMaxZoom);
    if (Math.abs(nextZoom - zoom) < 0.001) {
      return;
    }
    const point = viewportPoint(event);
    const worldX = (point.x - pan.x) / zoom;
    const worldY = (point.y - pan.y) / zoom;
    setZoom(nextZoom);
    setPan(clampPan(point.x - worldX * nextZoom, point.y - worldY * nextZoom, nextZoom));
  }

  function endPan(event: PointerEvent<SVGSVGElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      setIsDragging(false);
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  useEffect(() => {
    const next = graphFitView(props.graph);
    setZoom(next.zoom);
    setPan(clampPan(next.x, next.y, next.zoom));
  }, [props.graph]);

  useEffect(() => {
    setPan((current) => {
      const next = clampPan(current.x, current.y, zoom);
      return next.x === current.x && next.y === current.y ? current : next;
    });
  }, [props.graph.sceneHeight, props.graph.sceneWidth, zoom]);

  return (
    <div className="library-graph-shell">
      <div className="graph-zoom-readout">{Math.round(zoom * 100)}%</div>
      <svg
        className={isDragging ? "library-graph dragging" : "library-graph"}
        viewBox={`0 0 ${graphViewportWidth} ${graphViewportHeight}`}
        role="img"
        aria-label="Library graph"
        onPointerDown={startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onPointerLeave={endPan}
        onWheel={zoomGraph}
      >
        <defs>
          <linearGradient id="folderNodeGradient" x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="#edf8f6" />
            <stop offset="100%" stopColor="#cfeae6" />
          </linearGradient>
          <linearGradient id="paperNodeGradient" x1="0%" x2="100%" y1="0%" y2="100%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="100%" stopColor="#e7edf6" />
          </linearGradient>
        </defs>
        <rect className="graph-pan-surface" x="0" y="0" width={graphViewportWidth} height={graphViewportHeight} />
        <g className="graph-world" transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          <rect className="graph-world-boundary" x="24" y="24" width={props.graph.sceneWidth - 48} height={props.graph.sceneHeight - 48} rx="18" />
          <g className="graph-links">
            {props.graph.links.map((link) => (
              <path
                key={link.id}
                d={`M ${link.source.x} ${link.source.y} C ${(link.source.x + link.target.x) / 2} ${link.source.y}, ${(link.source.x + link.target.x) / 2} ${link.target.y}, ${link.target.x} ${link.target.y}`}
              />
            ))}
          </g>
          <g className="graph-nodes">
            {props.graph.nodes.map((node) => {
              const delay = `${(stableNumber(node.id) % 900) / 1000}s`;
              if (node.kind === "folder" && node.folder) {
                const label = graphNodeLabelMetrics(node);
                return (
                  <g
                    key={node.id}
                    className="graph-node graph-folder-node"
                    role="button"
                    tabIndex={0}
                    style={{ "--graph-float-delay": delay } as CSSProperties}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => node.folder && props.onFolder(node.folder)}
                    onKeyDown={(event) => {
                      if ((event.key === "Enter" || event.key === " ") && node.folder) {
                        event.preventDefault();
                        props.onFolder(node.folder);
                      }
                    }}
                  >
                    <title>{node.folder.id === "root" ? node.label : props.folderPath(node.folder.id)}</title>
                    <g transform={`translate(${node.x} ${node.y})`}>
                      <circle className="graph-halo" r={node.r + 10} />
                      <circle className="graph-main-circle" r={node.r} />
                      <text className="graph-count-label" textAnchor="middle" y="4">
                        {node.count}
                      </text>
                      <rect className="graph-label-backdrop" x={-label.width / 2} y={label.y - 12} width={label.width} height={label.height} rx="8" />
                      <text className="graph-folder-label" textAnchor="middle" y={label.y}>
                        {label.lines.map((line, index) => (
                          <tspan key={line} x="0" dy={index === 0 ? 0 : graphLabelLineHeight}>
                            {line}
                          </tspan>
                        ))}
                      </text>
                    </g>
                  </g>
                );
              }
              if (node.kind === "document" && node.document) {
                const selected = props.selectedDocumentIds.has(node.document.id);
                const status = readingStatusOption(readingStatusFromSettings(props.settings, node.document.id));
                const label = graphNodeLabelMetrics(node);
                const metaY = label.y + label.lines.length * graphLabelLineHeight + 12;
                return (
                  <g
                    key={node.id}
                    className={selected ? "graph-node graph-paper-node selected" : "graph-node graph-paper-node"}
                    role="button"
                    tabIndex={0}
                    style={{
                      "--graph-float-delay": delay,
                      "--reading-status-color": status.color,
                      "--reading-status-bg": status.background,
                    } as CSSProperties}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => node.document && setInspectedDocument(node.document)}
                    onKeyDown={(event) => {
                      if ((event.key === "Enter" || event.key === " ") && node.document) {
                        event.preventDefault();
                        setInspectedDocument(node.document);
                      }
                    }}
                  >
                    <title>{node.label}</title>
                    <g transform={`translate(${node.x} ${node.y})`}>
                      <circle className="graph-halo" r={node.r + 8} />
                      <circle className="graph-paper-dot" r={node.r} />
                      <rect className="graph-label-backdrop graph-paper-label-backdrop" x={-label.width / 2} y={label.y - 12} width={label.width} height={label.height} rx="8" />
                      <text className="graph-paper-label" textAnchor="middle" y={label.y}>
                        {label.lines.map((line, index) => (
                          <tspan key={line} x="0" dy={index === 0 ? 0 : graphLabelLineHeight}>
                            {line}
                          </tspan>
                        ))}
                      </text>
                      <text className="graph-paper-meta" textAnchor="middle" y={metaY}>
                        {`${node.document.year || ""}${node.document.year ? " · " : ""}${status.shortLabel}`}
                      </text>
                    </g>
                  </g>
                );
              }
              return null;
            })}
          </g>
        </g>
      </svg>
      {inspectedDocument && (
        <DocumentGraphModal
          document={inspectedDocument}
          note={props.notes.find((note) => note.documentId === inspectedDocument.id) ?? null}
          status={readingStatusFromSettings(props.settings, inspectedDocument.id)}
          onClose={() => setInspectedDocument(null)}
          onOpen={() => {
            props.onDocument(inspectedDocument);
            setInspectedDocument(null);
          }}
          onSave={async (markdown, status) => {
            await props.onSaveDocumentDetails(inspectedDocument, markdown, status);
            setInspectedDocument((current) => (current?.id === inspectedDocument.id ? { ...current } : current));
          }}
        />
      )}
    </div>
  );
}

function DocumentGraphModal(props: {
  document: DocumentRecord;
  note: NoteRecord | null;
  status: ReadingStatus;
  onClose: () => void;
  onOpen: () => void;
  onSave: (markdown: string, status: ReadingStatus) => Promise<void>;
}) {
  const [draftNote, setDraftNote] = useState(props.note?.markdown ?? "");
  const [draftStatus, setDraftStatus] = useState<ReadingStatus>(props.status);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const saveRequestRef = useRef(0);
  const onSaveRef = useRef(props.onSave);

  useEffect(() => {
    onSaveRef.current = props.onSave;
  }, [props.onSave]);

  useEffect(() => {
    setDraftNote(props.note?.markdown ?? "");
    setDraftStatus(props.status);
    setSaveState("idle");
  }, [props.document.id]);

  useEffect(() => {
    const savedNote = props.note?.markdown ?? "";
    if (draftNote === savedNote && draftStatus === props.status) {
      return;
    }
    const requestId = saveRequestRef.current + 1;
    saveRequestRef.current = requestId;
    setSaveState("idle");
    const timer = window.setTimeout(() => {
      setSaveState("saving");
      void onSaveRef.current(draftNote, draftStatus)
        .then(() => {
          if (saveRequestRef.current === requestId) {
            setSaveState("saved");
          }
        })
        .catch(() => {
          if (saveRequestRef.current === requestId) {
            setSaveState("error");
          }
        });
    }, 550);
    return () => window.clearTimeout(timer);
  }, [draftNote, draftStatus, props.document.id, props.note?.markdown, props.status]);

  function hasUnsavedDraft() {
    return draftNote !== (props.note?.markdown ?? "") || draftStatus !== props.status;
  }

  function flushDraft() {
    if (!hasUnsavedDraft()) {
      return;
    }
    saveRequestRef.current += 1;
    void onSaveRef.current(draftNote, draftStatus).catch(() => undefined);
  }

  function closeModal() {
    flushDraft();
    props.onClose();
  }

  function openDocument() {
    flushDraft();
    props.onOpen();
  }

  return (
    <div
      className="graph-document-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={props.document.title || props.document.fileName}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          closeModal();
        }
      }}
    >
      <section className="graph-document-modal" onPointerDown={(event) => event.stopPropagation()}>
        <div className="graph-document-head">
          <div>
            <span className="graph-document-kicker">{props.document.year || "연도 미상"}</span>
            <h2>{props.document.title || props.document.fileName}</h2>
            <p>{props.document.authors || "저자 정보 없음"}</p>
          </div>
          <button className="icon-button" title="닫기" onClick={closeModal}>
            <X size={16} />
          </button>
        </div>

        <div className="reading-status-grid" role="radiogroup" aria-label="읽기 상태">
          {readingStatusOptions.map((option) => (
            <button
              key={option.value}
              className={draftStatus === option.value ? "reading-status-choice active" : "reading-status-choice"}
              style={{ "--reading-status-color": option.color, "--reading-status-bg": option.background } as CSSProperties}
              role="radio"
              aria-checked={draftStatus === option.value}
              onClick={() => {
                setDraftStatus(option.value);
              }}
            >
              <span />
              <strong>{option.label}</strong>
            </button>
          ))}
        </div>

        <textarea
          className="graph-note-field"
          value={draftNote}
          onChange={(event) => {
            setDraftNote(event.target.value);
          }}
          placeholder="읽으면서 남길 핵심 메모, 의문점, 다시 볼 부분을 적어두세요."
        />

        <div className="graph-document-actions">
          <small className={saveState === "error" ? "graph-save-status error" : "graph-save-status"}>
            {saveState === "saving" && "저장 중"}
            {saveState === "saved" && "자동 저장됨"}
            {saveState === "error" && "자동 저장 실패"}
          </small>
          <button className="wide-command compact" onClick={openDocument}>
            <BookOpen size={16} />
            <span>논문 열기</span>
          </button>
        </div>
      </section>
    </div>
  );
}

export function EmptyReader(props: { label?: string; hint?: string; onPickFile: () => void }) {
  const ui = useUiStrings();
  return (
    <div className="empty-reader">
      <Upload size={36} />
      <strong>{props.label || ui.emptyReaderTitle}</strong>
      <span>{props.hint || ui.emptyReaderHint}</span>
      <button className="wide-command" onClick={props.onPickFile}>
        <Upload size={17} />
        <span>{ui.selectPdf}</span>
      </button>
    </div>
  );
}
