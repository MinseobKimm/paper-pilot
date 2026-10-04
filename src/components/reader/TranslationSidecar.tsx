import { useEffect, useRef, type PointerEvent } from "react";
import { RefreshCw, Sparkles, X } from "../icons";
import { InlineMathText } from "../FormattedAiText";
import type { TranslationUnit } from "../../lib/translations";
import type { UiStrings } from "../../lib/uiStrings";

function ReadableTranslationText(props: { text: string }) {
  return <InlineMathText text={props.text.replace(/\s+/g, " ").trim()} />;
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
    selectedRef.current?.focus({ preventScroll: true });
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
              : unit.status === "failed"
                ? props.ui.translationFailed
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
              <div className="translation-content">
                <ReadableTranslationText text={text} />
              </div>
            </button>
          );
        })}
      </div>
      {props.pending && <div className="translation-status">{props.ui.agentPending}</div>}
    </aside>
  );
}
