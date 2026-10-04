import { useEffect, useRef, useState } from "react";
import { Trash2 } from "../../icons";
import { useUiStrings } from "../../../lib/uiStrings";
import type { NoteRecord } from "../../../types";
import { obsidianOpen, obsidianReconnect, obsidianResolve, obsidianStatus, type ObsidianStatus } from "../../../lib/tauri";

const indent = "  ";

function lineIndent(value: string, caret: number) {
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  return value.slice(lineStart).match(/^[ \t]*/)?.[0] ?? "";
}

function levelFromIndent(leading: string) {
  return Math.floor((leading.replace(/\t/g, indent).length + 1) / indent.length);
}

export function NotesPanel(props: {
  documentId: string;
  obsidianEnabled: boolean;
  language: "ko" | "en";
  note: NoteRecord | null;
  onSaveNote: (markdown: string) => Promise<void>;
  onDeleteNote: () => Promise<void>;
}) {
  const ui = useUiStrings();
  const ko = props.language === "ko";
  const [draft, setDraft] = useState(props.note?.markdown ?? "");
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  const [currentLevel, setCurrentLevel] = useState(0);
  const [obsidian, setObsidian] = useState<ObsidianStatus | null>(null);
  const [obsidianError, setObsidianError] = useState("");
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  const savedRef = useRef(props.note?.markdown ?? "");
  const saveRef = useRef(props.onSaveNote);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuedRef = useRef<string | null>(null);
  const savingRef = useRef(false);
  const mountedRef = useRef(true);
  const deletingRef = useRef(false);
  saveRef.current = props.onSaveNote;

  useEffect(() => {
    if (!props.obsidianEnabled) { setObsidian(null); return; }
    let live = true;
    const refresh = () => { void obsidianStatus(props.documentId).then((status) => { if (live) setObsidian(status); }).catch((error) => { if (live) setObsidianError(String(error)); }); };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [props.documentId, props.obsidianEnabled]);

  async function obsidianAction(action: "disconnect" | "recreate" | "overwrite" | "locate" | "open") {
    try {
      setObsidianError("");
      if (action === "open") await obsidianOpen(props.documentId);
      else if (action === "locate") await obsidianReconnect(props.documentId);
      else await obsidianResolve(props.documentId, action);
      setObsidian(await obsidianStatus(props.documentId));
    } catch (error) { setObsidianError(String(error)); }
  }

  function clearSaveTimer() {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  async function drainSaves() {
    if (savingRef.current || deletingRef.current) return;
    savingRef.current = true;
    while (queuedRef.current !== null) {
      const value = queuedRef.current;
      queuedRef.current = null;
      if (value === savedRef.current) continue;
      if (mountedRef.current) setSaveState("saving");
      try {
        await saveRef.current(value);
        savedRef.current = value;
        if (mountedRef.current) setSaveState(draftRef.current === value ? "saved" : "dirty");
        if (draftRef.current !== value && queuedRef.current === null) {
          queuedRef.current = draftRef.current;
        }
      } catch {
        if (mountedRef.current) setSaveState("error");
        break;
      }
    }
    savingRef.current = false;
  }

  function flushSave() {
    clearSaveTimer();
    if (deletingRef.current || draftRef.current === savedRef.current) return;
    queuedRef.current = draftRef.current;
    void drainSaves();
  }

  function changeDraft(value: string) {
    draftRef.current = value;
    setDraft(value);
    setSaveState(value === savedRef.current ? "saved" : "dirty");
    clearSaveTimer();
    if (value !== savedRef.current) timerRef.current = setTimeout(flushSave, 650);
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      flushSave();
    };
  }, []);

  function changeIndent(outdent: boolean) {
    const editor = editorRef.current;
    if (!editor) return;
    const { selectionStart: start, selectionEnd: end, value } = editor;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const effectiveEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
    const nextBreak = value.indexOf("\n", effectiveEnd);
    const lineEnd = nextBreak < 0 ? value.length : nextBreak;
    const lines = value.slice(lineStart, lineEnd).split("\n");
    const changes = lines.map((line) => {
      if (!outdent) return { text: indent + line, shift: indent.length };
      const leading = line.match(/^(?: {1,2}|\t)/)?.[0] ?? "";
      return { text: line.slice(leading.length), shift: -leading.length };
    });
    const next = value.slice(0, lineStart) + changes.map((change) => change.text).join("\n") + value.slice(lineEnd);
    const nextStart = Math.max(lineStart, start + changes[0].shift);
    const nextEnd = Math.max(nextStart, end + changes.reduce((total, change) => total + change.shift, 0));
    changeDraft(next);
    setCurrentLevel(levelFromIndent(changes[0].text.match(/^[ \t]*/)?.[0] ?? ""));
    requestAnimationFrame(() => {
      editor.focus();
      editor.setSelectionRange(nextStart, nextEnd);
    });
  }

  function continueAtCurrentLevel() {
    const editor = editorRef.current;
    if (!editor) return;
    const { selectionStart: start, selectionEnd: end, value } = editor;
    const leading = lineIndent(value, start);
    const insertion = `\n${leading}`;
    changeDraft(value.slice(0, start) + insertion + value.slice(end));
    setCurrentLevel(levelFromIndent(leading));
    requestAnimationFrame(() => editor.setSelectionRange(start + insertion.length, start + insertion.length));
  }

  async function deleteNote() {
    deletingRef.current = true;
    clearSaveTimer();
    queuedRef.current = null;
    try {
      await props.onDeleteNote();
      draftRef.current = "";
      savedRef.current = "";
      setDraft("");
      setSaveState("idle");
    } catch {
      setSaveState("error");
    } finally {
      deletingRef.current = false;
    }
  }

  return (
    <div className="panel-stack notes-panel">
      <div className="note-editor-toolbar">
        <div className="note-indent-actions" aria-label={ui.noteIndentTools}>
          <button type="button" title={ui.noteOutdentHint} aria-label={ui.noteOutdent} onMouseDown={(event) => event.preventDefault()} onClick={() => changeIndent(true)}>{ui.noteOutdent}</button>
          <button type="button" title={ui.noteIndentHint} aria-label={ui.noteIndent} onMouseDown={(event) => event.preventDefault()} onClick={() => changeIndent(false)}>{ui.noteIndent}</button>
        </div>
        <span className="note-level-indicator">{ui.noteInputLevel} {currentLevel + 1}</span>
        <small className={saveState === "error" ? "note-save-status error" : "note-save-status"} role="status">
          {saveState === "dirty" && ui.unsavedChanges}
          {saveState === "saving" && ui.saving}
          {saveState === "saved" && ui.saved}
          {saveState === "error" && ui.saveFailed}
        </small>
      </div>
      <textarea
        ref={editorRef}
        value={draft}
        onChange={(event) => {
          changeDraft(event.target.value);
          setCurrentLevel(levelFromIndent(lineIndent(event.target.value, event.target.selectionStart)));
        }}
        onSelect={(event) => setCurrentLevel(levelFromIndent(lineIndent(event.currentTarget.value, event.currentTarget.selectionStart)))}
        onBlur={flushSave}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            event.preventDefault();
            changeIndent(event.shiftKey);
          } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            continueAtCurrentLevel();
          } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            flushSave();
          }
        }}
        placeholder={ui.markdownNotes}
        aria-label={ui.markdownNotes}
        spellCheck
      />
      <div className="note-editor-footer">
        <span>{ui.noteIndentShortcut}</span>
        <button type="button" className="note-delete-button" disabled={saveState === "saving" || (!props.note?.markdown && !draft)} onClick={() => void deleteNote()}>
          <Trash2 size={15} /> {ui.deleteNote}
        </button>
      </div>
      {props.obsidianEnabled && <div className="note-obsidian-status" role="status">
        <span>Obsidian: {obsidian?.state === "synced" ? (ko ? "반영됨" : "Synced") : obsidian?.state === "pending" ? (ko ? "대기 중" : "Pending") : obsidian?.state === "conflict" || obsidian?.state === "attention" ? (ko ? "확인 필요" : "Needs attention") : obsidian?.state === "disconnected" ? (ko ? "연결 해제됨" : "Disconnected") : (ko ? "준비 중" : "Preparing")}</span>
        {obsidian?.relativePath && ["synced", "conflict"].includes(obsidian.state) && <button type="button" onClick={() => void obsidianAction("open")}>{ko ? "Obsidian에서 열기" : "Open in Obsidian"}</button>}
        {(obsidian?.state === "attention") && <><button type="button" onClick={() => void obsidianAction("locate")}>{ko ? "파일 다시 찾기" : "Locate file"}</button><button type="button" onClick={() => void obsidianAction("recreate")}>{ko ? "새 파일 만들기" : "Create new file"}</button></>}
        {(obsidian?.state === "conflict") && <><button type="button" onClick={() => void obsidianAction("disconnect")}>{ko ? "연결 해제" : "Disconnect"}</button><button type="button" onClick={() => void obsidianAction("overwrite")}>{ko ? "백업 후 적용" : "Back up and apply"}</button></>}
        {(obsidian?.state === "disconnected") && <button type="button" onClick={() => void obsidianAction("recreate")}>{ko ? "다시 연결" : "Reconnect"}</button>}
        {(obsidian?.error || obsidianError) && <small>{obsidianError || obsidian?.error}</small>}
      </div>}
    </div>
  );
}
