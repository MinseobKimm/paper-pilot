import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Copy, Maximize2, Send, Trash2, X } from "../icons";
import { FormattedAiText } from "../FormattedAiText";
import { explanationTasks } from "../../lib/annotationHelpers";
import { formatResultTime, getReadableAiOutput, stripChatAskPrefix, taskTitle } from "../../lib/aiResults";
import { useUiStrings } from "../../lib/uiStrings";
import type { AiResultRecord } from "../../types";

export function FloatingAiCard(props: {
  result: AiResultRecord;
  results: AiResultRecord[];
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
  onFollowUp?: (result: AiResultRecord, question: string) => Promise<void>;
}) {
  const ui = useUiStrings();
  const [expanded, setExpanded] = useState(false);
  const [position, setPosition] = useState(() => initialFloatingPosition(props.avoidRect ?? null));
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const rootId = props.result.parentResultId || props.result.id;
  const root = props.results.find((result) => result.id === rootId) ?? props.result;
  const isExplanation = explanationTasks.has(root.taskType.toString());
  const followUps = props.results
    .filter((result) => result.parentResultId === rootId)
    .slice()
    .sort(compareCreatedAt);
  const threadKey = [root.id, root.status, root.outputText.length, ...followUps.map((result) => `${result.id}:${result.status}:${result.outputText.length}`)].join("|");

  useEffect(() => {
    setExpanded(false);
    setPosition(initialFloatingPosition(props.avoidRect ?? null));
    setDraft("");
  }, [root.id, props.avoidRect]);

  useEffect(() => {
    const node = threadRef.current;
    if (!node) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [threadKey]);

  async function sendFollowUp() {
    const question = draft.trim();
    if (!question || !props.onFollowUp || root.status === "pending") {
      return;
    }
    setSending(true);
    try {
      await props.onFollowUp(root, question);
      setDraft("");
    } finally {
      setSending(false);
    }
  }

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
          <strong>{taskTitle(root.taskType.toString(), ui)}</strong>
          {followUps.length > 0 && <span className="floating-thread-count">{followUps.length}</span>}
        </div>
        <div>
          <button title={expanded ? ui.compactView : ui.fullScreen} onClick={() => setExpanded((value) => !value)}>
            <Maximize2 size={15} />
          </button>
          <button title={ui.copy} onClick={props.onCopy}>
            <Copy size={15} />
          </button>
          {isExplanation && (
            <button title={ui.deleteExplanation} onClick={() => props.onDelete(root)}>
              <Trash2 size={15} />
            </button>
          )}
          <button title={ui.close} onClick={props.onClose}>
            <X size={15} />
          </button>
        </div>
      </div>
      <div className="floating-card-body">
        <div ref={threadRef} className="floating-card-thread">
          <article className={`floating-thread-answer ${root.status}`}>
            <div className="floating-thread-meta">{formatResultTime(root.createdAt)}</div>
            {root.status === "pending" ? (
              <p className="chat-pending-status">{ui.aiPendingAnswer}<span aria-hidden="true" /></p>
            ) : (
              <FormattedAiText text={getReadableAiOutput(root, ui)} />
            )}
          </article>
          {followUps.map((result) => {
            const answer = getReadableAiOutput(result, ui);
            return (
              <article key={result.id} className="floating-thread-turn">
                <div className="floating-thread-question">
                  {stripChatAskPrefix(result.inputText) || result.inputText}
                </div>
                <div className={`floating-thread-answer ${result.status}`}>
                  <div className="floating-thread-meta">{formatResultTime(result.createdAt)}</div>
                  {result.status === "pending" ? (
                    <p className="chat-pending-status">{ui.aiPendingAnswer}<span aria-hidden="true" /></p>
                  ) : (
                    <FormattedAiText text={answer} />
                  )}
                </div>
              </article>
            );
          })}
        </div>
        {isExplanation && (
          <form
            className="floating-followup-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendFollowUp();
            }}
          >
            <textarea
              value={draft}
              disabled={root.status === "pending" || sending}
              placeholder={ui.askAnything}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
                  return;
                }
                event.preventDefault();
                void sendFollowUp();
              }}
            />
            <button type="submit" title={ui.send} disabled={!draft.trim() || root.status === "pending" || sending}>
              <Send size={16} />
            </button>
          </form>
        )}
      </div>
    </aside>
  );
}

function compareCreatedAt(a: AiResultRecord, b: AiResultRecord) {
  const aTime = new Date(a.createdAt).getTime();
  const bTime = new Date(b.createdAt).getTime();
  return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
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
