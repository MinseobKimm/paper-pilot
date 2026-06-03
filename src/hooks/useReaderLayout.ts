import { useEffect, useMemo, useState, type CSSProperties, type PointerEvent } from "react";
import type { AppStateRecord } from "../types";
import {
  clampNumber,
  defaultReaderZoom,
  documentZoomSettingKey,
  layoutBounds,
  layoutDefaults,
  maxReaderZoom,
  minReaderZoom,
  settingsNumber,
  zoomFromSettings,
  type LayoutPane,
} from "../lib/readerSettings";
import { setSetting } from "../lib/tauri";

type PatchState = (mutator: (draft: AppStateRecord) => void) => void;

export function useReaderLayout(settings: Record<string, string>, activeDocumentId: string | null, patchState: PatchState) {
  const [zoom, setZoom] = useState(defaultReaderZoom);
  const [layoutOverride, setLayoutOverride] = useState<Partial<Record<LayoutPane, number>>>({});

  const savedLayout = useMemo(
    () => ({
      outline: settingsNumber(settings, layoutBounds.outline.setting, layoutDefaults.outline, layoutBounds.outline.min, layoutBounds.outline.max),
      translation: settingsNumber(
        settings,
        layoutBounds.translation.setting,
        layoutDefaults.translation,
        layoutBounds.translation.min,
        layoutBounds.translation.max,
      ),
      rightPanel: settingsNumber(settings, layoutBounds.rightPanel.setting, layoutDefaults.rightPanel, layoutBounds.rightPanel.min, layoutBounds.rightPanel.max),
    }),
    [settings],
  );
  const readerLayout = useMemo(
    () => ({
      ...savedLayout,
      ...layoutOverride,
    }),
    [layoutOverride, savedLayout],
  );
  const readerGridStyle = useMemo(
    () =>
      ({
        "--outline-width": `${readerLayout.outline}px`,
        "--translation-width": `${readerLayout.translation}px`,
        "--right-panel-width": `${readerLayout.rightPanel}px`,
      }) as CSSProperties,
    [readerLayout],
  );

  useEffect(() => {
    const savedZoom = zoomFromSettings(settings, activeDocumentId);
    setZoom((current) => (Math.abs(current - savedZoom) < 0.001 ? current : savedZoom));
  }, [activeDocumentId, settings]);

  function persistLayoutPane(pane: LayoutPane, value: number) {
    const bounds = layoutBounds[pane];
    const next = Math.round(clampNumber(value, bounds.min, bounds.max));
    patchState((draft) => {
      draft.settings[bounds.setting] = String(next);
    });
    void setSetting(bounds.setting, String(next));
  }

  function startLayoutResize(pane: LayoutPane, event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startValue = readerLayout[pane];
    const direction = pane === "rightPanel" ? -1 : 1;
    let latest = startValue;
    const bounds = layoutBounds[pane];
    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      latest = Math.round(clampNumber(startValue + (moveEvent.clientX - startX) * direction, bounds.min, bounds.max));
      setLayoutOverride((current) => ({ ...current, [pane]: latest }));
    };
    const handleDone = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleDone);
      window.removeEventListener("pointercancel", handleDone);
      persistLayoutPane(pane, latest);
      window.setTimeout(() => {
        setLayoutOverride((current) => {
          const next = { ...current };
          delete next[pane];
          return next;
        });
      }, 0);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleDone);
    window.addEventListener("pointercancel", handleDone);
  }

  function commitZoom(nextZoom: number) {
    const next = Math.round(clampNumber(nextZoom, minReaderZoom, maxReaderZoom) * 100) / 100;
    setZoom(next);
    if (!activeDocumentId) {
      return;
    }
    const key = documentZoomSettingKey(activeDocumentId);
    patchState((draft) => {
      draft.settings[key] = String(next);
    });
    void setSetting(key, String(next));
  }

  return {
    zoom,
    readerLayout,
    readerGridStyle,
    commitZoom,
    startLayoutResize,
  };
}
