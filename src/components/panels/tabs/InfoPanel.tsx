import { Download, FileArchive, ListTree, Search } from "../../icons";
import { OutlineTitleText } from "../../FormattedAiText";
import { folderDisplayName, folderTreeRows } from "../../../lib/libraryTree";
import type { OutlineRow } from "../../../lib/outlines";
import { useUiStrings } from "../../../lib/uiStrings";
import type { DocumentRecord, FolderRecord } from "../../../types";

export function InfoPanel(props: {
  document: DocumentRecord;
  folders: FolderRecord[];
  outlineRows: OutlineRow[];
  searchMatches: number[];
  onMetadata: (field: keyof DocumentRecord, value: string | boolean | null) => void;
  onMoveFolder: (folderId: string) => void;
  onGoToPage: (page: number) => void;
  onJsonExport: () => void;
  onZipExport: () => void;
}) {
  const ui = useUiStrings();
  const folderOptions = folderTreeRows(props.folders, []).map((row) => ({
    id: row.folder.id,
    label: `${"  ".repeat(row.depth)}${folderDisplayName(row.folder, ui)}`,
  }));
  return (
    <div className="panel-stack">
      <label className="field">
        <span>{ui.title}</span>
        <input value={props.document.title} onChange={(event) => props.onMetadata("title", event.target.value)} />
      </label>
      <label className="field">
        <span>{ui.authors}</span>
        <input value={props.document.authors} onChange={(event) => props.onMetadata("authors", event.target.value)} />
      </label>
      <label className="field">
        <span>{ui.year}</span>
        <input value={props.document.year} onChange={(event) => props.onMetadata("year", event.target.value)} />
      </label>
      <label className="field">
        <span>{ui.abstract}</span>
        <textarea value={props.document.abstractText} onChange={(event) => props.onMetadata("abstractText", event.target.value)} />
      </label>
      <label className="field">
        <span>{ui.folder}</span>
        <select value={props.document.folderId ?? "root"} onChange={(event) => props.onMoveFolder(event.target.value)}>
          {folderOptions.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.label}
            </option>
          ))}
        </select>
      </label>
      <label className="toggle-row">
        <input
          type="checkbox"
          checked={props.document.bookmarked}
          onChange={(event) => props.onMetadata("bookmarked", event.target.checked)}
        />
        <span>{ui.bookmark}</span>
      </label>
      <div className="command-grid">
        <button onClick={props.onJsonExport}>
          <Download size={16} />
          <span>{ui.jsonExport}</span>
        </button>
        <button onClick={props.onZipExport}>
          <FileArchive size={16} />
          <span>{ui.zipExport}</span>
        </button>
      </div>
      <section className="panel-section">
        <h3>{ui.outline}</h3>
        {(props.outlineRows.length ? props.outlineRows : [{ id: "page-1", page: 1, title: `${ui.page} 1`, level: 0, source: "page" as const }]).map((row, index) => (
          <button key={`${row.id}-${index}`} className="outline-row" onClick={() => props.onGoToPage(row.page)}>
            <ListTree size={14} />
            <span>
              <OutlineTitleText text={row.title} />
            </span>
          </button>
        ))}
      </section>
      <section className="panel-section">
        <h3>{ui.searchHits}</h3>
        {props.searchMatches.map((page) => (
          <button key={page} className="outline-row" onClick={() => props.onGoToPage(page)}>
            <Search size={14} />
            <span>{ui.page} {page}</span>
          </button>
        ))}
        {props.searchMatches.length === 0 && <p className="muted">{ui.noActiveSearchHits}</p>}
      </section>
    </div>
  );
}
