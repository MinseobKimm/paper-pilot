/** Keep the measured popover inside the viewport, including after its contents grow. */
export function wordPopupPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const margin = 12;
  const minTop = Math.min(72, Math.max(margin, viewportHeight - height - margin));
  return {
    left: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    top: Math.max(minTop, Math.min(y - height / 2, viewportHeight - height - margin)),
  };
}
