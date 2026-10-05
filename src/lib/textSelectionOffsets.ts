/** Find the nearest caret using rendered glyph widths, including PDF scaleX transforms. */
export function textOffsetAtX(span: HTMLElement, x: number): number {
  const text = span.textContent || span.dataset.text || "";
  const rect = span.getBoundingClientRect();
  const offsets = [0];
  for (const character of text) offsets.push(offsets[offsets.length - 1] + character.length);
  const node = span.firstChild;
  const range = node ? span.ownerDocument.createRange() : null;
  const boundary = (index: number) => {
    if (index === 0) return rect.left;
    if (!range || !node) return rect.left + rect.width * offsets[index] / Math.max(1, text.length);
    range.setStart(node, 0);
    range.setEnd(node, offsets[index]);
    return range.getBoundingClientRect().right;
  };
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (boundary(middle) < x) low = middle + 1;
    else high = middle;
  }
  const previous = Math.max(0, low - 1);
  return offsets[Math.abs(boundary(previous) - x) <= Math.abs(boundary(low) - x) ? previous : low];
}

export function sliceTextSpan(span: HTMLElement, start: number, end: number): { text: string; rect: DOMRect } | null {
  const text = span.textContent || span.dataset.text || "";
  if (end <= start) return null;
  const node = span.firstChild;
  if (node) {
    const range = span.ownerDocument.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return { text: text.slice(start, end), rect: range.getBoundingClientRect() };
  }
  const rect = span.getBoundingClientRect();
  const left = rect.left + rect.width * start / Math.max(1, text.length);
  const right = rect.left + rect.width * end / Math.max(1, text.length);
  return { text: text.slice(start, end), rect: { ...rect, left, right, width: right - left } };
}
