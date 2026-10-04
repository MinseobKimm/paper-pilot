import { Copy, Highlighter, Languages, Maximize2, MessageCircle } from "../icons";
import { highlightColors } from "../../lib/highlights";
import type { SelectionToolbar } from "../../lib/pdfText";
import { useUiStrings } from "../../lib/uiStrings";
type SelectionToolbarViewProps = {
  toolbar: SelectionToolbar;
  onExplain: () => void;
  onTranslate: () => void;
  onComment: () => void;
  onChat: () => void;
  onCopyLatex: () => void;
  onHighlight: (color: string) => void;
};

export function SelectionToolbarView(props: SelectionToolbarViewProps) {
  const ui = useUiStrings();
  const left = Math.max(12, Math.min(props.toolbar.x, window.innerWidth - 252));
  const top = Math.max(72, Math.min(props.toolbar.y, window.innerHeight - 290));
  return (
    <div className="selection-toolbar" style={{ left, top }}>
      <button className="selection-row" onClick={props.onExplain}>
        <Maximize2 size={15} />
        <span>{ui.explain}</span>
        <kbd>E</kbd>
      </button>
      <button className="selection-row" onClick={() => props.onHighlight(highlightColors[0].value)}>
        <Highlighter size={15} />
        <span>{ui.highlight}</span>
        <i className="selected-color" style={{ background: "#f7c8f1" }} />
        <kbd>H</kbd>
      </button>
      <button className="selection-row" onClick={props.onTranslate}>
        <Languages size={15} />
        <span>{ui.translate}</span>
        <kbd>T</kbd>
      </button>
      <button className="selection-row" onClick={props.onComment}>
        <MessageCircle size={15} />
        <span>{ui.comment}</span>
        <kbd>C</kbd>
      </button>
      <button className="selection-row" onClick={props.onCopyLatex}>
        <Copy size={15} />
        <span>{ui.copy}</span>
      </button>
      <span className="selection-palette">
        {highlightColors.map((color) => (
          <button
            key={color.value}
            title={`${ui.highlight} ${color.name} (${color.key})`}
            className="color-dot"
            style={{ background: color.value }}
            onClick={() => props.onHighlight(color.value)}
          />
        ))}
      </span>
    </div>
  );
}
