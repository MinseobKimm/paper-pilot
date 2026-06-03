import { useEffect, useState } from "react";
import { Save, Trash2 } from "../../icons";
import { useUiStrings } from "../../../lib/uiStrings";
import type { NoteRecord } from "../../../types";

export function NotesPanel(props: {
  note: NoteRecord | null;
  fullText: string;
  onSaveNote: (markdown: string) => Promise<void>;
  onDeleteNote: () => Promise<void>;
}) {
  const ui = useUiStrings();
  const [draft, setDraft] = useState(props.note?.markdown ?? "");
  const [saveState, setSaveState] = useState<"idle" | "dirty" | "saving" | "saved" | "error">("idle");
  useEffect(() => {
    setDraft(props.note?.markdown ?? "");
    setSaveState("idle");
  }, [props.note?.id]);

  async function submitNote() {
    setSaveState("saving");
    try {
      await props.onSaveNote(draft);
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }

  return (
    <div className="panel-stack notes-panel">
      <textarea
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setSaveState("dirty");
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            void submitNote();
          }
        }}
        placeholder={ui.markdownNotes}
      />
      <div className="note-actions">
        <button className="wide-command" disabled={saveState === "saving"} onClick={() => void submitNote()}>
          <Save size={16} />
          <span>{saveState === "saving" ? ui.saving : ui.saveNote}</span>
        </button>
        <button
          className="wide-command danger"
          disabled={saveState === "saving" || (!props.note?.markdown && !draft)}
          onClick={() => {
            void props.onDeleteNote().then(() => {
              setDraft("");
              setSaveState("idle");
            });
          }}
        >
          <Trash2 size={16} />
          <span>{ui.deleteNote}</span>
        </button>
      </div>
      <small className={saveState === "error" ? "note-save-status error" : "note-save-status"}>
        {saveState === "dirty" && ui.unsavedChanges}
        {saveState === "saved" && ui.saved}
        {saveState === "error" && ui.saveFailed}
      </small>
    </div>
  );
}
