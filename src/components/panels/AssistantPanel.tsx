import { useEffect, useRef, useState } from "react";
import { Copy, MessageSquareText, Search, Send, Trash2 } from "../icons";
import { FormattedAiText } from "../FormattedAiText";
import { aiRuntimeLabel } from "../../lib/aiPreferences";
import {
  chatAskModeKind,
  chatAskModeLabel,
  formatResultTime,
  getReadableAiOutput,
  resultTokenEstimateText,
  stripChatAskPrefix,
  taskTitle,
} from "../../lib/aiResults";
import { annotationFilters, explanationResultId, explanationTasks } from "../../lib/annotationHelpers";
import { useUiStrings } from "../../lib/uiStrings";
import type { AiResultRecord, AiTaskType, AnnotationRecord } from "../../types";

export type ReaderAssistantMode = "study" | "quotes";
type ChatAskMode = "auto" | "fast" | "deep";

export function AssistantPanel(props: {
  annotations: AnnotationRecord[];
  aiResults: AiResultRecord[];
  settings: Record<string, string>;
  chatDraft: string;
  setChatDraft: (value: string) => void;
  mode: ReaderAssistantMode;
  onQueueTask: (type: AiTaskType, payload: Record<string, unknown>) => void;
  onHoverSource: (value: string | null) => void;
  onGoToPage: (page: number) => void;
  onCopy: (text: string, label: string) => void;
  onDeleteExplanation: (result: AiResultRecord) => void;
}) {
  const ui = useUiStrings();
  return (
    <div className={props.mode === "quotes" ? "assistant-surface quote-mode" : "assistant-surface"}>
      {props.mode === "study" && (
        <div className="chat-panel">
          <ChatThread
            results={props.aiResults}
            onHoverSource={props.onHoverSource}
            onGoToPage={props.onGoToPage}
            onCopy={props.onCopy}
          />
          <ChatComposer
            value={props.chatDraft}
            onChange={props.setChatDraft}
            modelLabel={aiRuntimeLabel(props.settings, ui)}
            onSend={(askMode) => {
              const question = props.chatDraft.trim();
              if (!question) {
                return;
              }
              props.onQueueTask("chatWithPaper", { question, askMode });
              props.setChatDraft("");
            }}
          />
        </div>
      )}
      {props.mode === "quotes" && (
        <QuoteCardPanel
          results={props.aiResults}
          annotations={props.annotations}
          onCopy={props.onCopy}
          onHoverSource={props.onHoverSource}
          onDeleteExplanation={props.onDeleteExplanation}
        />
      )}
    </div>
  );
}

function ChatThread(props: {
  results: AiResultRecord[];
  onHoverSource: (value: string | null) => void;
  onGoToPage: (page: number) => void;
  onCopy: (text: string, label: string) => void;
}) {
  const ui = useUiStrings();
  const threadRef = useRef<HTMLElement | null>(null);
  const chatResults = props.results
    .filter((result) => result.taskType.toString() === "chatWithPaper")
    .slice()
    .sort((a, b) => {
      const aTime = new Date(a.createdAt).getTime();
      const bTime = new Date(b.createdAt).getTime();
      return (Number.isNaN(aTime) ? 0 : aTime) - (Number.isNaN(bTime) ? 0 : bTime);
    });
  const scrollKey = chatResults.map((result) => `${result.id}:${result.status}:${result.outputText.length}`).join("|");
  useEffect(() => {
    const node = threadRef.current;
    if (!node) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollKey]);
  return (
    <section ref={threadRef} className="chat-thread" aria-label={ui.askAi}>
      {chatResults.length === 0 && (
        <div className="chat-thread-empty">
          <MessageSquareText size={20} />
          <strong>{ui.askAi}</strong>
          <span>{ui.askAnything}</span>
        </div>
      )}
      {chatResults.map((result) => {
        const isPending = result.status === "pending";
        const question = stripChatAskPrefix(result.inputText);
        const modeKind = chatAskModeKind(result.inputText);
        const modeLabel = chatAskModeLabel(result.inputText);
        const pendingAnswer =
          modeKind === "auto"
            ? "질문을 분석하는 중입니다"
            : modeKind === "fast"
              ? "Fast가 관련 페이지 근거를 찾는 중입니다"
              : modeKind === "deep"
                ? "Deep이 원본 PDF를 확인하는 중입니다"
                : ui.aiPendingAnswer.replace(/[.。]+$/, "");
        const answer =
          isPending ? pendingAnswer : getReadableAiOutput(result, ui);
        const tokenEstimate = resultTokenEstimateText(result);
        return (
          <article key={result.id} className="chat-turn">
            <div className="chat-bubble user">
              <p>{question || result.inputText}</p>
            </div>
            <div
              className={`chat-bubble assistant ${result.status}`}
              onMouseEnter={() => props.onHoverSource(result.inputText)}
              onMouseLeave={() => props.onHoverSource(null)}
            >
              <div className="chat-bubble-head">
                {modeLabel && <span className={`chat-mode-pill ${modeKind}`}>{modeLabel}</span>}
                <span className="chat-turn-meta">{[formatResultTime(result.createdAt), tokenEstimate].filter(Boolean).join(" / ")}</span>
                {!isPending && (
                  <button title={ui.copy} onClick={() => props.onCopy(answer, ui.askAi)}>
                    <Copy size={13} />
                  </button>
                )}
              </div>
              {isPending ? (
                <p className="chat-pending-status">{answer}<span aria-hidden="true" /></p>
              ) : (
                <FormattedAiText text={answer} onPageCitation={props.onGoToPage} />
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function QuoteCardPanel(props: {
  results: AiResultRecord[];
  annotations: AnnotationRecord[];
  onCopy: (text: string, label: string) => void;
  onHoverSource: (value: string | null) => void;
  onDeleteExplanation: (result: AiResultRecord) => void;
}) {
  const ui = useUiStrings();
  const quoteResults = props.results.filter((result) =>
    ["explainText", "explainRegionImage", "citationReason", "externalLinkSummary"].includes(result.taskType.toString()),
  );
  return (
    <section className="quote-card-panel">
      <h3>{ui.explain}</h3>
      <div className="annotation-filters">
        <label><input type="checkbox" defaultChecked /> {ui.all}</label>
        {annotationFilters.map((filter) => (
          <label key={filter.id}>
            <input type="checkbox" defaultChecked />
            <span style={{ background: filter.color }}>{ui[filter.labelKey]}</span>
          </label>
        ))}
      </div>
      <div className="quote-search">
        <Search size={15} />
        <input placeholder={ui.quoteSearch} />
      </div>
      {quoteResults.map((result) => {
        const linkedAnnotation = props.annotations.find((annotation) => explanationResultId(annotation) === result.id);
        const isExplanation = explanationTasks.has(result.taskType.toString());
        const pageLabel = linkedAnnotation ? `Page ${linkedAnnotation.page}` : "";
        return (
          <article
            key={result.id}
            className="quote-card"
            onMouseEnter={() => props.onHoverSource(result.inputText)}
            onMouseLeave={() => props.onHoverSource(null)}
          >
            <div className="quote-avatar">Tt</div>
            <div>
              <time>{[formatResultTime(result.createdAt), "Chat 0", pageLabel].filter(Boolean).join(" / ")}</time>
              <h4>{taskTitle(result.taskType.toString(), ui)}</h4>
              <FormattedAiText text={getReadableAiOutput(result, ui)} compact={!isExplanation} />
            </div>
            <div className="quote-card-actions">
              <button title={ui.copy} onClick={() => props.onCopy(getReadableAiOutput(result, ui), taskTitle(result.taskType.toString(), ui))}>
                <Copy size={16} />
              </button>
              {isExplanation && (
                <button title={ui.deleteExplanation} onClick={() => props.onDeleteExplanation(result)}>
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          </article>
        );
      })}
      {quoteResults.length === 0 && <p className="muted">{ui.quoteCardsEmpty}</p>}
    </section>
  );
}

function ChatComposer(props: { value: string; modelLabel: string; onChange: (value: string) => void; onSend: (mode: ChatAskMode) => void }) {
  const ui = useUiStrings();
  const [askMode, setAskMode] = useState<ChatAskMode>("auto");
  const send = () => {
    props.onSend(askMode);
  };
  return (
    <div className="assistant-composer">
      <div className="ask-mode-tabs" role="tablist" aria-label="Ask AI mode">
        {[
          ["auto", "Auto"],
          ["fast", "Fast"],
          ["deep", "Deep"],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={askMode === value ? "active" : ""}
            aria-selected={askMode === value}
            onClick={() => setAskMode(value as ChatAskMode)}
          >
            {label}
          </button>
        ))}
      </div>
      <textarea
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
            return;
          }
          event.preventDefault();
          send();
        }}
        placeholder={ui.askAnything}
      />
      <div className="composer-footer">
        <span className="composer-model-chip">{props.modelLabel}</span>
        <button className="send-round" title={ui.send} onClick={send}><Send size={15} /></button>
      </div>
    </div>
  );
}
