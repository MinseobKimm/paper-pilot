import { useEffect, useRef, type PointerEvent } from "react";
import { RefreshCw, Sparkles, X } from "../icons";
import { InlineMathText } from "../FormattedAiText";
import type { TranslationUnit } from "../../lib/translations";
import type { UiStrings } from "../../lib/uiStrings";
function readableTranslationLines(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [""];
  }
  const chunks = normalized
    .split(/(?<=[.!?])\s+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line.trim()) {
      lines.push(line.trim());
      line = "";
    }
  };
  for (const chunk of chunks.length ? chunks : [normalized]) {
    const next = line ? `${line} ${chunk}` : chunk;
    if (line && next.length > 82) {
      flush();
      line = chunk;
    } else {
      line = next;
    }
    if (/[.!?]$/.test(chunk) && line.length > 48) {
      flush();
    }
  }
  flush();
  return lines.flatMap((item) => {
    if (item.length <= 110) {
      return [item];
    }
    return item.match(/.{1,100}(?:\s|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [item];
  });
}


function ReadableTranslationText(props: { text: string }) {
  return (
    <>
      {readableTranslationLines(props.text).map((line, index) => (
        <span key={`${line}-${index}`} className="translation-line">
          <InlineMathText text={line} inlineOnly />
        </span>
      ))}
    </>
  );
}

export function TranslationSidecar(props: {
  ui: UiStrings;
  translationLanguageName: string;
  page: number;
  pageCount: number;
  units: TranslationUnit[];
  selectedSentenceId: string | null;
  pending: boolean;
  autoTranslate: boolean;
  onSelectSentence: (id: string) => void;
  onRefresh: () => void;
  onTranslatePage: () => void;
  onResizeStart: (event: PointerEvent) => void;
  onClose: () => void;
}) {
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  const unitKey = props.units.map((unit) => `${unit.id}:${(unit.sourceIds ?? []).join(",")}`).join("|");
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [props.selectedSentenceId, unitKey]);

  return (
    <aside className="translation-sidecar" aria-label={props.ui.translationPanel}>
      <button className="panel-resizer right" title="Resize translation panel" onPointerDown={props.onResizeStart} />
      <div className="translation-head">
        <div className="auto-state">
          <span>{props.ui.auto}</span>
          <b>{props.autoTranslate ? "ON" : "OFF"}</b>
        </div>
        <strong>
          {props.page} / {Math.max(1, props.pageCount)} · {props.translationLanguageName}
        </strong>
        <div className="translation-head-actions">
          <button title={props.ui.translatePage} onClick={props.onTranslatePage}>
            <Sparkles size={15} />
          </button>
          <button title={props.ui.refreshTranslation} onClick={props.onRefresh}>
            <RefreshCw size={15} />
          </button>
          <button title={props.ui.closeTranslationPanel} onClick={props.onClose}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="translation-body">
        {props.units.length === 0 && (
          <div className="translation-empty">{props.ui.emptyTranslation}</div>
        )}
        {props.units.map((unit) => {
          const sourceIds = unit.sourceIds?.length ? unit.sourceIds : [unit.id];
          const active = Boolean(props.selectedSentenceId && (unit.id === props.selectedSentenceId || sourceIds.includes(props.selectedSentenceId)));
          const text =
            unit.translation ||
            (unit.status === "pending"
              ? props.ui.translationPending
              : props.ui.translationMissing);
          return (
            <button
              key={unit.id}
              ref={active ? selectedRef : null}
              data-sentence-id={unit.id}
              data-source-sentence-ids={sourceIds.join(" ")}
              className={active ? "translation-sentence active" : "translation-sentence"}
              onClick={() => props.onSelectSentence(sourceIds[0] ?? unit.id)}
            >
              <span>{unit.index + 1}</span>
              <p>
                <ReadableTranslationText text={text} />
              </p>
            </button>
          );
        })}
      </div>
      {props.pending && <div className="translation-status">{props.ui.agentPending}</div>}
    </aside>
  );
}
