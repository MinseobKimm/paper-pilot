import { useEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Copy, Maximize2, Trash2, X } from "../icons";
import { FormattedAiText } from "../FormattedAiText";
import { explanationTasks } from "../../lib/annotationHelpers";
import { getReadableAiOutput, taskTitle } from "../../lib/aiResults";
import { useUiStrings } from "../../lib/uiStrings";
import type { AiResultRecord } from "../../types";

export function FloatingAiCard(props: {
  result: AiResultRecord;
  avoidRect?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } | null;
  onClose: () => void;
  onCopy: () => void;
  onDelete: (result: AiResultRecord) => void;
}) {
  const ui = useUiStrings();
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState(() => initialFloatingPosition(props.avoidRect ?? null));
  const isExplanation = explanationTasks.has(props.result.taskType.toString());

  useEffect(() => {
    setExpanded(false);
    setPosition(initialFloatingPosition(props.avoidRect ?? null));
  }, [props.result.id, props.avoidRect]);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (expanded || (event.target as HTMLElement).closest("button")) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = position;
    const handleMove = (moveEvent: PointerEvent) => {
      const size = floatingCardSize();
      setPosition({
        left: clamp(start.left + moveEvent.clientX - startX, 12, window.innerWidth - size.width - 12),
        top: clamp(start.top + moveEvent.clientY - startY, 54, window.innerHeight - 72),
      });
    };
    const handleDone = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleDone);
      window.removeEventListener("pointercancel", handleDone);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleDone);
    window.addEventListener("pointercancel", handleDone);
  }

  const cardStyle = expanded
    ? undefined
    : ({
        left: position.left,
        top: position.top,
      } satisfies CSSProperties);

  return (
    <aside className={expanded ? "floating-ai-card expanded" : "floating-ai-card"} style={cardStyle}>
      <div className="floating-card-head" onPointerDown={startDrag}>
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function floatingCardSize() {
  const width = Math.min(560, Math.max(320, window.innerWidth * 0.48));
  const height = Math.min(620, window.innerHeight * 0.7);
  return { width, height };
}

function initialFloatingPosition(
  avoidRect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } | null,
) {
  const margin = 16;
  const edge = 12;
  const toolbarTop = 54;
  const size = floatingCardSize();
  const defaultLeft = clamp(window.innerWidth - size.width - 382, edge, window.innerWidth - size.width - edge);
  const defaultTop = clamp(window.innerHeight - size.height - 38, toolbarTop, window.innerHeight - 72);
  if (!avoidRect) {
    return { left: defaultLeft, top: defaultTop };
  }
  const maxLeft = window.innerWidth - size.width - edge;
  const maxTop = window.innerHeight - size.height - edge;
  if (avoidRect.right + margin + size.width <= window.innerWidth - edge) {
    return {
      left: avoidRect.right + margin,
      top: clamp(avoidRect.top, toolbarTop, maxTop),
    };
  }
  if (avoidRect.left - margin - size.width >= edge) {
    return {
      left: avoidRect.left - margin - size.width,
      top: clamp(avoidRect.top, toolbarTop, maxTop),
    };
  }
  if (avoidRect.bottom + margin + size.height <= window.innerHeight - edge) {
    return {
      left: clamp(avoidRect.left, edge, maxLeft),
      top: avoidRect.bottom + margin,
    };
  }
  if (avoidRect.top - margin - size.height >= toolbarTop) {
    return {
      left: clamp(avoidRect.left, edge, maxLeft),
      top: avoidRect.top - margin - size.height,
    };
  }
  return {
    left: defaultLeft,
    top: defaultTop,
  };
}
