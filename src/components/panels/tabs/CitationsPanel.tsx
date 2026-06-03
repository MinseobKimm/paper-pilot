import { Copy, Download, Link, Search, Trash2 } from "../../icons";
import { citationCardsToBibtex, citationCardsToCsv } from "../../../lib/citations";
import { openPaperUrl } from "../../../lib/scholarly";
import { useUiStrings } from "../../../lib/uiStrings";
import type { AiTaskType, CitationCardRecord, DocumentRecord } from "../../../types";

export function CitationsPanel(props: {
  document: DocumentRecord;
  citations: CitationCardRecord[];
  onExtractCitations: () => void;
  onResolveCitationLinks: () => void;
  onDeleteCitation: (id: string) => void;
  onSaveCitation: (card: CitationCardRecord) => void;
  onQueueTask: (type: AiTaskType, payload: Record<string, unknown>) => void;
  onCopy: (text: string, label: string) => void;
  onHoverSource: (value: string | null) => void;
}) {
  const ui = useUiStrings();
  return (
    <div className="panel-stack">
      <div className="command-grid">
        <button onClick={props.onExtractCitations}>
          <Search size={16} />
          <span>{ui.extractReferences}</span>
        </button>
        <button onClick={props.onResolveCitationLinks}>
          <Link size={16} />
          <span>{ui.findLinks}</span>
        </button>
        <button onClick={() => void props.onCopy(citationCardsToBibtex(props.citations), "BibTeX")}>
          <Copy size={16} />
          <span>BibTeX</span>
        </button>
        <button onClick={() => void props.onCopy(citationCardsToCsv(props.citations), "CSV")}>
          <Download size={16} />
          <span>CSV</span>
        </button>
      </div>
      {props.citations.map((card) => (
        <article
          key={card.id}
          className="citation-card"
          onMouseEnter={() => props.onHoverSource(card.rawReference)}
          onMouseLeave={() => props.onHoverSource(null)}
        >
          <div className="citation-head">
            <strong>{card.title || ui.untitledReference}</strong>
            <button title={ui.deleteCitation} className="icon-button" onClick={() => props.onDeleteCitation(card.id)}>
              <Trash2 size={15} />
            </button>
          </div>
          <p>{card.authors}</p>
          <div className="micro-actions">
            <button disabled={!card.url && !card.doi} onClick={() => openPaperUrl(card)}>{ui.openPaper}</button>
            {card.doi && <button onClick={() => openPaperUrl({ ...card, url: "" })}>DOI</button>}
          </div>
          <textarea
            value={card.reason}
            onChange={(event) => props.onSaveCitation({ ...card, reason: event.target.value })}
            placeholder={ui.citationReasonPlaceholder}
          />
          <div className="micro-actions">
            <button onClick={() => props.onQueueTask("citationReason", { reference: card.rawReference })}>{ui.reason}</button>
            <button onClick={() => props.onQueueTask("externalLinkSummary", { url: card.url, reference: card.rawReference })}>{ui.linkSummary}</button>
          </div>
        </article>
      ))}
      {props.citations.length === 0 && <p className="muted">{ui.extractReferencesEmpty}</p>}
    </div>
  );
}
