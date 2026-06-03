import { Trash2 } from "../../icons";
import { highlightColors } from "../../../lib/highlights";
import { useUiStrings } from "../../../lib/uiStrings";
import type { AnnotationRecord } from "../../../types";

export function ActivityPanel(props: {
  annotations: AnnotationRecord[];
  onUpdateAnnotation: (annotation: AnnotationRecord) => void;
  onDeleteAnnotation: (id: string) => void;
  onDeleteAllAnnotations: () => void;
  onGoToPage: (page: number) => void;
}) {
  const ui = useUiStrings();
  const grouped = props.annotations.reduce<Record<string, AnnotationRecord[]>>((accumulator, annotation) => {
    const key = annotation.tag || annotation.kind;
    accumulator[key] = accumulator[key] ?? [];
    accumulator[key].push(annotation);
    return accumulator;
  }, {});
  return (
    <div className="panel-stack">
      <button className="wide-command danger" onClick={props.onDeleteAllAnnotations} disabled={props.annotations.length === 0}>
        <Trash2 size={16} />
        <span>{ui.deleteAllHighlights}</span>
      </button>
      {Object.entries(grouped).map(([group, annotations]) => (
        <section key={group} className="panel-section">
          <h3>{group}</h3>
          {annotations.map((annotation) => (
            <article key={annotation.id} className="annotation-row">
              <button className="swatch" style={{ background: annotation.color }} title={ui.goToHighlight} onClick={() => props.onGoToPage(annotation.page)} />
              <div>
                <strong>{ui.page} {annotation.page}</strong>
                <p>{annotation.text}</p>
                <div className="annotation-colors">
                  {highlightColors.map((color) => (
                    <button
                      key={color.value}
                      className="color-dot"
                      style={{ background: color.value }}
                      title={`${ui.changeTo} ${color.name}`}
                      onClick={() => props.onUpdateAnnotation({ ...annotation, color: color.value })}
                    />
                  ))}
                </div>
              </div>
              <button title={ui.delete} className="icon-button" onClick={() => props.onDeleteAnnotation(annotation.id)}>
                <Trash2 size={15} />
              </button>
            </article>
          ))}
        </section>
      ))}
      {props.annotations.length === 0 && <p className="muted">{ui.manualAiHighlightsEmpty}</p>}
    </div>
  );
}
