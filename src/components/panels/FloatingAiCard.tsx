import { useState } from "react";
import { Copy, Maximize2, Trash2, X } from "../icons";
import { FormattedAiText } from "../FormattedAiText";
import { explanationTasks } from "../../lib/annotationHelpers";
import { getReadableAiOutput, taskTitle } from "../../lib/aiResults";
import { useUiStrings } from "../../lib/uiStrings";
import type { AiResultRecord } from "../../types";

export function FloatingAiCard(props: {
  result: AiResultRecord;
  onClose: () => void;
  onCopy: () => void;
  onDelete: (result: AiResultRecord) => void;
}) {
  const ui = useUiStrings();
  const [expanded, setExpanded] = useState(false);
  const isExplanation = explanationTasks.has(props.result.taskType.toString());
  return (
    <aside className={expanded ? "floating-ai-card expanded" : "floating-ai-card"}>
      <div className="floating-card-head">
        <div>
          <Maximize2 size={16} />
          <strong>{taskTitle(props.result.taskType.toString(), ui)}</strong>
        </div>
        <div>
          <button title={expanded ? ui.compactView : ui.fullScreen} onClick={() => setExpanded((value) => !value)}>
            <Maximize2 size={15} />
          </button>
          <button title={ui.copy} onClick={props.onCopy}>
            <Copy size={15} />
          </button>
          {isExplanation && (
            <button title={ui.deleteExplanation} onClick={() => props.onDelete(props.result)}>
              <Trash2 size={15} />
            </button>
          )}
          <button title={ui.close} onClick={props.onClose}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="floating-card-body">
        <FormattedAiText text={getReadableAiOutput(props.result, ui)} />
      </div>
    </aside>
  );
}
