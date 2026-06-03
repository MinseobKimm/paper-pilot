import type { CSSProperties } from "react";
import { Archive, BookOpen, Bookmark, BookmarkCheck, ChevronRight, FileText, FolderOpen, FolderPlus, Move, PenLine, Search, Trash2, Upload } from "./icons";
import type { AppStateRecord, DocumentRecord, FolderRecord } from "../types";
import { folderDisplayName, folderPathLabel, folderTreeRows } from "../lib/libraryTree";
import { useUiStrings } from "../lib/uiStrings";
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
            <span>{ui.allDocuments}</span>
          </button>
          {props.state.folders.map((folder) => (
            <button
              key={folder.id}
              className={props.folderFilter === folder.id ? "folder-row active" : "folder-row"}
              onClick={() => props.onFolderFilter(folder.id)}
            >
              <FolderOpen size={16} />
              <span>{folderDisplayName(folder, ui)}</span>
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
};

export function LibraryManagerView(props: LibraryManagerViewProps) {
  const ui = useUiStrings();
  const selectedSet = new Set(props.selectedDocumentIds);
  const visibleIds = props.documents.map((document) => document.id);
  const visibleIdSet = new Set(visibleIds);
  const selectedVisibleIds = props.selectedDocumentIds.filter((id) => visibleIdSet.has(id));
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedSet.has(id));
  const folderRows = folderTreeRows(props.state.folders, props.state.documents);
  const folderOptions = folderRows.map((row) => ({
    id: row.folder.id,
    label: `${"  ".repeat(row.depth)}${folderDisplayName(row.folder, ui)}`,
  }));
  const currentFolderLabel = props.folderFilter === "all" ? ui.allPapers : folderPathLabel(props.state.folders, props.folderFilter, ui);
  const currentParentId = props.folderFilter === "all" ? "root" : props.folderFilter;

  return (
    <section className="library-view">
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
            className={props.folderFilter === "all" ? "folder-row active" : "folder-row"}
            onClick={() => props.onFolderFilter("all")}
          >
            <Archive size={16} />
            <span>{ui.allPapers}</span>
          </button>
          <div className="folder-tree">
            {folderRows.map((row) => (
              <div
                key={row.folder.id}
                className="folder-tree-row"
                data-folder-id={row.folder.id}
                style={{ "--folder-depth": row.depth } as CSSProperties}
              >
                <button
                  className={props.folderFilter === row.folder.id ? "folder-row active" : "folder-row"}
                  onClick={() => props.onFolderFilter(row.folder.id)}
                  title={folderPathLabel(props.state.folders, row.folder.id, ui)}
                >
                  {row.childCount > 0 ? <ChevronRight size={13} /> : <span className="folder-row-spacer" />}
                  <FolderOpen size={16} />
                  <span>{folderDisplayName(row.folder, ui)}</span>
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
        <div className="library-controls">
          <div className="search-box wide">
            <Search size={16} />
            <input
              value={props.libraryQuery}
              onChange={(event) => props.onLibraryQuery(event.target.value)}
              placeholder={ui.librarySearchPlaceholder}
            />
          </div>
          <span className="muted">{currentFolderLabel} · {props.documents.length} {ui.papersSuffix}</span>
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
        <div className="document-grid">
          {props.documents.map((document) => (
            <article
              key={document.id}
              className={selectedSet.has(document.id) ? "document-card active" : "document-card"}
              title={document.title || document.fileName}
              onClick={() => props.onSelect(document.id)}
              onDoubleClick={() => props.onOpen(document)}
            >
              <div className="document-card-head">
                <label className="document-check" onClick={(event) => event.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selectedSet.has(document.id)}
                    onChange={(event) => props.onToggleSelect(document.id, event.target.checked)}
                  />
                </label>
                <FileText size={20} />
                <button
                  className="bookmark-button"
                  title={`${ui.rename} ${ui.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onRenameDocument(document);
                  }}
                >
                  <PenLine size={18} />
                </button>
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
              <small className="document-folder-path">{folderPathLabel(props.state.folders, document.folderId, ui)}</small>
              <div className="document-meta">
                <span>{document.year || ui.unknownYear}</span>
                <span>{document.pageCount || "-"}{ui.pageSuffix}</span>
              </div>
              <label className="document-folder-select" onClick={(event) => event.stopPropagation()}>
                <Move size={14} />
                <select value={document.folderId ?? "root"} onChange={(event) => props.onMoveDocuments([document.id], event.target.value)}>
                  {folderOptions.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="document-card-actions">
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
                <button
                  className="icon-button danger"
                  title={ui.deletePaper}
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onDeleteDocuments([document.id]);
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          ))}
          {props.documents.length === 0 && (
            <div className="empty-list">
              <Upload size={30} />
              <strong>{ui.noPaperInView}</strong>
              <span>{ui.addPdfOrChooseFolder}</span>
            </div>
          )}
        </div>
      </div>
    </section>
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
