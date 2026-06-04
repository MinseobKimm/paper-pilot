import * as pdfjsLib from "pdfjs-dist";
import type { HighlightRect } from "../types";

export type PdfTextItem = { str?: string; transform?: number[]; fontName?: string; width?: number; height?: number };

export type PdfTextViewport = { width: number; height: number; transform: number[] };

export type SelectionToolbar = {
  text: string;
  page: number;
  x: number;
  y: number;
  rects: HighlightRect[];
};

export type TextSelectionGesture = {
  page: number;
  pageElement: HTMLElement;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
};

export type TextLayerBox = {
  text: string;
  start: number;
  end: number;
  rect: { left: number; top: number; width: number; height: number };
  fontSize: number;
  fontName: string;
};

export type TextLine = {
  text: string;
  rect: { left: number; top: number; width: number; height: number };
  fontSize: number;
  fontNames: string[];
  boxes: TextLayerBox[];
};

export type PageTextLayoutInference = {
  mode: DocumentTextLayoutMode;
  confidence: number;
  reason: string;
};

export type DocumentTextLayoutMode = "single" | "two-column";

function cleanSelectedText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeTextLayerText(value: string) {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?%])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .replace(/\s+([)\]}])/g, "$1")
    .trim();
}

export function medianNumber(values: number[]) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function quantileNumber(values: number[], quantile: number) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(1, quantile)) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function lineRight(line: TextLine) {
  return line.rect.left + line.rect.width;
}

function lineBottom(line: TextLine) {
  return line.rect.top + line.rect.height;
}

function lineCenterX(line: TextLine) {
  return line.rect.left + line.rect.width / 2;
}

function lineCenterY(line: TextLine) {
  return line.rect.top + line.rect.height / 2;
}

export function textLinesFromBoxes(boxes: TextLayerBox[], layoutMode: DocumentTextLayoutMode | "auto" = "auto") {
  const sorted = [...boxes]
    .filter((box) => box.text.trim())
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  const groups: Array<{
    boxes: TextLayerBox[];
    top: number;
    bottom: number;
  }> = [];
  for (const box of sorted) {
    const midY = box.rect.top + box.rect.height / 2;
    let existing: (typeof groups)[number] | undefined;
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      const groupMid = (group.top + group.bottom) / 2;
      const tolerance = Math.max(5, Math.min(box.rect.height, group.bottom - group.top) * 0.65);
      if (Math.abs(groupMid - midY) <= tolerance) {
        existing = group;
        break;
      }
    }
    if (existing) {
      existing.boxes.push(box);
      existing.top = Math.min(existing.top, box.rect.top);
      existing.bottom = Math.max(existing.bottom, box.rect.top + box.rect.height);
    } else {
      groups.push({
        boxes: [box],
        top: box.rect.top,
        bottom: box.rect.top + box.rect.height,
      });
    }
  }
  const lineRows = groups.flatMap((group) => {
    const sortedBoxes = [...group.boxes].sort((a, b) => a.rect.left - b.rect.left);
    const clusters: TextLayerBox[][] = [];
    for (const box of sortedBoxes) {
      const current = clusters[clusters.length - 1];
      const previous = current?.[current.length - 1];
      if (!current || !previous) {
        clusters.push([box]);
        continue;
      }
      const previousRight = previous.rect.left + previous.rect.width;
      const gap = box.rect.left - previousRight;
      const fontSize = Math.max(previous.fontSize, box.fontSize, 8);
      const columnGap = Math.max(42, fontSize * 3.2);
      if (gap > columnGap) {
        clusters.push([box]);
      } else {
        current.push(box);
      }
    }
    return clusters;
  });
  const lines = lineRows
    .map((lineBoxes) => {
      let text = "";
      for (const [index, box] of lineBoxes.entries()) {
        const previous = lineBoxes[index - 1];
        if (!previous) {
          text = box.text;
          continue;
        }
        const previousRight = previous.rect.left + previous.rect.width;
        const gap = box.rect.left - previousRight;
        const tightJoin =
          gap <= Math.max(4, Math.min(previous.fontSize, box.fontSize) * 0.28) ||
          /^[,.;:!?%)}\]]/.test(box.text) ||
          /[({\[]$/.test(previous.text);
        text += tightJoin ? box.text : ` ${box.text}`;
      }
      const left = Math.min(...lineBoxes.map((box) => box.rect.left));
      const top = Math.min(...lineBoxes.map((box) => box.rect.top));
      const right = Math.max(...lineBoxes.map((box) => box.rect.left + box.rect.width));
      const bottom = Math.max(...lineBoxes.map((box) => box.rect.top + box.rect.height));
      return {
        text: normalizeTextLayerText(text),
        rect: {
          left,
          top,
          width: right - left,
          height: bottom - top,
        },
        fontSize: medianNumber(lineBoxes.map((box) => box.fontSize)),
        fontNames: [...new Set(lineBoxes.map((box) => box.fontName).filter(Boolean))],
        boxes: lineBoxes,
      } satisfies TextLine;
    })
    .filter((line) => line.text.length > 0);
  if (lines.length < 4 || layoutMode === "single") {
    return lines.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  }
  const minLeft = Math.min(...lines.map((line) => line.rect.left));
  const maxRight = Math.max(...lines.map((line) => line.rect.left + line.rect.width));
  const span = Math.max(1, maxRight - minLeft);
  const bodyLines = lines.filter((line) => {
    const width = line.rect.width;
    const center = line.rect.left + width / 2;
    return width < span * 0.72 && center > minLeft + span * 0.08 && center < maxRight - span * 0.08;
  });
  if (bodyLines.length < 4 && layoutMode !== "two-column") {
    return lines.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  }
  const centers = bodyLines.map((line) => line.rect.left + line.rect.width / 2).sort((a, b) => a - b);
  let bestGap = 0;
  let splitAt = -1;
  for (let index = 1; index < centers.length; index += 1) {
    const gap = centers[index] - centers[index - 1];
    if (gap > bestGap) {
      bestGap = gap;
      splitAt = index;
    }
  }
  const twoColumn = layoutMode === "two-column" || (splitAt > 0 && bestGap > Math.max(72, span * 0.16));
  if (!twoColumn) {
    return lines.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
  }
  const splitX = splitAt > 0 ? (centers[splitAt - 1] + centers[splitAt]) / 2 : minLeft + span / 2;
  const isFullWidth = (line: TextLine) => line.rect.width > span * 0.72;
  const columnFor = (line: TextLine) => {
    return line.rect.left + line.rect.width / 2 >= splitX ? 1 : 0;
  };
  const sortSegment = (segment: TextLine[]) =>
    segment.sort((a, b) => {
      const columnA = columnFor(a);
      const columnB = columnFor(b);
      if (columnA !== columnB) {
        return columnA - columnB;
      }
      return a.rect.top - b.rect.top || a.rect.left - b.rect.left;
    });
  const ordered: TextLine[] = [];
  let segment: TextLine[] = [];
  for (const line of [...lines].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)) {
    if (isFullWidth(line)) {
      ordered.push(...sortSegment(segment));
      segment = [];
      ordered.push(line);
    } else {
      segment.push(line);
    }
  }
  ordered.push(...sortSegment(segment));
  return ordered;
}

export function joinHyphenatedLineText(previous: string, next: string) {
  const left = previous.trimEnd();
  const right = next.trimStart();
  if (/[A-Za-z]-$/.test(left) && /^[A-Za-z]/.test(right)) {
    return `${left.slice(0, -1)}${right}`;
  }
  return `${left}\n${right}`;
}

export function textFromOrderedLines(lines: TextLine[]) {
  return lines.reduce((text, line) => (text ? joinHyphenatedLineText(text, line.text) : line.text), "");
}

export function textAndBoxesFromOrderedLines(lines: TextLine[]) {
  const text = textFromOrderedLines(lines);
  const boxes: TextLayerBox[] = [];
  let textCursor = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const previousLine = lineIndex > 0 ? lines[lineIndex - 1] : null;
    const joinedHyphen = Boolean(previousLine && /[A-Za-z]-$/.test(previousLine.text.trimEnd()) && /^[A-Za-z]/.test(line.text.trimStart()));
    if (lineIndex > 0 && !joinedHyphen) {
      textCursor += 1;
    }
    let lineCursor = 0;
    for (const [boxIndex, box] of line.boxes.entries()) {
      const raw = box.text.trim();
      if (!raw) {
        continue;
      }
      const isHyphenatedLineEnd = boxIndex === line.boxes.length - 1 && /[A-Za-z]-$/.test(raw);
      const indexText = isHyphenatedLineEnd ? raw.slice(0, -1) : raw;
      const itemIndex = line.text.indexOf(raw, lineCursor);
      const itemStart = textCursor + (itemIndex >= 0 ? itemIndex : lineCursor);
      const itemEnd = itemStart + indexText.length;
      lineCursor = (itemIndex >= 0 ? itemIndex : lineCursor) + raw.length;
      boxes.push({
        ...box,
        text: raw,
        start: itemStart,
        end: itemEnd,
      });
    }
    textCursor += line.text.length - (/[A-Za-z]-$/.test(line.text.trimEnd()) ? 1 : 0);
  }
  return { text, boxes };
}

export function dehyphenateLineBreaks(text: string) {
  return text
    .replace(/([A-Za-z])-\s*\n\s*([A-Za-z])/g, "$1$2")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function pageTextFromPdfItems(
  items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }>,
  viewport: { width: number; height: number; transform: number[] },
  scale: number,
  layoutMode: DocumentTextLayoutMode | "auto" = "auto",
) {
  const { text } = textBoxesFromPdfItems(items, viewport, scale, layoutMode);
  const dehyphenated = dehyphenateLineBreaks(text);
  if (dehyphenated) {
    return dehyphenated;
  }
  return items.map((item) => item.str ?? "").join(" ").replace(/\s+/g, " ").trim();
}

function cleanPdfTitleText(value: string) {
  return value
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.pdf$/i, "")
    .trim();
}

function isWeakPdfTitleCandidate(value: string) {
  const text = cleanPdfTitleText(value);
  const lower = text.toLowerCase();
  if (text.length < 6 || text.length > 240) {
    return true;
  }
  if (/^(abstract|introduction|references|bibliography|contents|keywords?)\b/i.test(text)) {
    return true;
  }
  if (/\b(arxiv|doi|proceedings|conference|journal|workshop|preprint)\b/i.test(text) && text.length < 42) {
    return true;
  }
  if (/^[\W\d_]+$/.test(text) || lower === "untitled" || lower === "document") {
    return true;
  }
  return false;
}

export function inferPdfTitleFromPdfItems(
  items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }>,
  viewport: { width: number; height: number; transform: number[] },
  scale: number,
) {
  const lines = textLinesFromBoxes(pdfItemTextBoxes(items, viewport, scale), "single")
    .filter((line) => line.rect.top < viewport.height * 0.45)
    .filter((line) => !isWeakPdfTitleCandidate(line.text));
  if (lines.length === 0) {
    return "";
  }
  const fontSizes = lines.map((line) => line.fontSize).sort((a, b) => a - b);
  const medianFontSize = medianNumber(fontSizes);
  const maxFontSize = Math.max(...fontSizes);
  const titleMinFontSize = Math.max(medianFontSize * 1.16, maxFontSize * 0.76);
  const titleLikeLines = lines.filter((line) => line.fontSize >= titleMinFontSize);
  const pool = titleLikeLines.length ? titleLikeLines : lines.slice(0, 4);
  const first = pool[0];
  const firstIndex = lines.indexOf(first);
  const group = [first];
  for (const line of lines.slice(firstIndex + 1)) {
    const previous = group[group.length - 1];
    const gap = line.rect.top - (previous.rect.top + previous.rect.height);
    if (gap > Math.max(18, previous.fontSize * 1.55) || line.fontSize < first.fontSize * 0.72) {
      break;
    }
    group.push(line);
    if (cleanPdfTitleText(group.map((item) => item.text).join(" ")).length > 180) {
      break;
    }
  }
  const title = cleanPdfTitleText(group.map((line) => line.text).join(" "));
  return isWeakPdfTitleCandidate(title) ? "" : title;
}

export function closestTextLayerSpan(node: Node | null): HTMLElement | null {
  if (!node) {
    return null;
  }
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>(".text-layer [data-text]") ?? null;
}

function rectIntersectionArea(a: DOMRect, b: DOMRect) {
  const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

export function textLayerColumnInfo(
  spans: HTMLElement[],
  pageBounds: DOMRect,
  layoutMode: DocumentTextLayoutMode | "auto" = "auto",
) {
  if (layoutMode === "single") {
    return null;
  }
  const rects = spans
    .map((span) => span.getBoundingClientRect())
    .filter((rect) => rect.width > 1 && rect.height > 1);
  if (rects.length < 8) {
    return null;
  }
  const pageWidth = Math.max(1, pageBounds.width);
  const bodyRects = rects.filter((rect) => rect.width < pageWidth * 0.62);
  if (bodyRects.length < 8 && layoutMode !== "two-column") {
    return null;
  }
  const centers = bodyRects.map((rect) => rect.left + rect.width / 2).sort((a, b) => a - b);
  let bestGap = 0;
  let splitAt = -1;
  for (let index = 1; index < centers.length; index += 1) {
    const gap = centers[index] - centers[index - 1];
    if (gap > bestGap) {
      bestGap = gap;
      splitAt = index;
    }
  }
  const midpoint = pageBounds.left + pageWidth / 2;
  const leftCount = bodyRects.filter((rect) => rect.left + rect.width / 2 < midpoint).length;
  const rightCount = bodyRects.length - leftCount;
  if (layoutMode !== "two-column" && (splitAt <= 0 || bestGap < Math.max(48, pageWidth * 0.12))) {
    const balancedColumns = leftCount >= 4 && rightCount >= 4 && Math.min(leftCount, rightCount) / Math.max(leftCount, rightCount) > 0.22;
    if (!balancedColumns) {
      return null;
    }
  }
  const splitX = splitAt > 0 && bestGap >= Math.max(32, pageWidth * 0.06)
    ? (centers[splitAt - 1] + centers[splitAt]) / 2
    : midpoint;
  return {
    splitX,
    columnFor(rect: DOMRect) {
      return rect.left + rect.width / 2 >= splitX ? 1 : 0;
    },
    columnForPoint(x: number) {
      return x >= splitX ? 1 : 0;
    },
    isFullWidth(rect: DOMRect) {
      return rect.width > pageWidth * 0.66;
    },
  };
}

type SelectableSpanItem = { span: HTMLElement; order: number; rect: DOMRect; column: number; fullWidth: boolean };

function closestSpanToPoint(
  items: SelectableSpanItem[],
  x: number,
  y: number,
  column?: number,
) {
  const candidates = typeof column === "number" ? items.filter((item) => item.column === column || item.fullWidth) : items;
  const pool = candidates.length ? candidates : items;
  return pool
    .map((item) => {
      const dx = x < item.rect.left ? item.rect.left - x : x > item.rect.right ? x - item.rect.right : 0;
      const dy = y < item.rect.top ? item.rect.top - y : y > item.rect.bottom ? y - item.rect.bottom : 0;
      return { item, score: dx * dx + dy * dy };
    })
    .sort((a, b) => a.score - b.score || a.item.order - b.item.order)[0]?.item ?? null;
}

function spanRangeWithinVisualLines(
  items: SelectableSpanItem[],
  start: SelectableSpanItem,
  end: SelectableSpanItem,
  options: { gesture?: TextSelectionGesture; fullLinesForVerticalDrag?: boolean } = {},
) {
  if (items.length === 0) {
    return [];
  }
  const sorted = [...items].sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left || a.order - b.order);
  const heights = sorted.map((item) => item.rect.height).sort((a, b) => a - b);
  const medianHeight = heights[Math.floor(heights.length / 2)] ?? 10;
  const lineTolerance = Math.max(4, medianHeight * 0.8);
  const lines: Array<{ index: number; top: number; bottom: number; centerY: number; items: SelectableSpanItem[] }> = [];
  for (const item of sorted) {
    const centerY = item.rect.top + item.rect.height / 2;
    let line = lines[lines.length - 1];
    if (!line || Math.abs(centerY - line.centerY) > lineTolerance) {
      line = {
        index: lines.length,
        top: item.rect.top,
        bottom: item.rect.bottom,
        centerY,
        items: [],
      };
      lines.push(line);
    }
    line.items.push(item);
    line.top = Math.min(line.top, item.rect.top);
    line.bottom = Math.max(line.bottom, item.rect.bottom);
    line.centerY = (line.centerY * (line.items.length - 1) + centerY) / line.items.length;
  }
  const metas = lines.flatMap((line) =>
    line.items
      .sort((a, b) => a.rect.left - b.rect.left || a.order - b.order)
      .map((item) => ({
        ...item,
        line: line.index,
        centerX: item.rect.left + item.rect.width / 2,
      })),
  );
  const startMeta = metas.find((item) => item.order === start.order);
  const endMeta = metas.find((item) => item.order === end.order);
  if (!startMeta || !endMeta) {
    return [];
  }
  const forward =
    startMeta.line < endMeta.line ||
    (startMeta.line === endMeta.line && startMeta.centerX <= endMeta.centerX);
  const first = forward ? startMeta : endMeta;
  const last = forward ? endMeta : startMeta;
  const verticalDrag =
    options.fullLinesForVerticalDrag &&
    options.gesture &&
    first.line !== last.line &&
    Math.abs(options.gesture.endY - options.gesture.startY) > Math.max(18, Math.abs(options.gesture.endX - options.gesture.startX) * 1.2);
  return metas
    .filter((item) => {
      if (item.line < first.line || item.line > last.line) {
        return false;
      }
      if (verticalDrag) {
        return true;
      }
      if (first.line === last.line) {
        return item.centerX >= first.centerX - 1 && item.centerX <= last.centerX + 1;
      }
      if (item.line === first.line) {
        return item.centerX >= first.centerX - 1;
      }
      if (item.line === last.line) {
        return item.centerX <= last.centerX + 1;
      }
      return true;
    })
    .sort((a, b) => a.line - b.line || a.rect.left - b.rect.left || a.order - b.order)
    .map(({ span, order, rect }) => ({ span, order, rect }));
}

export function selectedSpansFromGesture(
  page: HTMLElement,
  spans: HTMLElement[],
  gesture: TextSelectionGesture,
  layoutMode: DocumentTextLayoutMode | "auto" = "auto",
): Array<{ span: HTMLElement; order: number; rect: DOMRect }> {
  const dragDistance = Math.hypot(gesture.endX - gesture.startX, gesture.endY - gesture.startY);
  if (dragDistance < 5) {
    return [];
  }
  const pageBounds = page.getBoundingClientRect();
  const columnInfo = layoutMode !== "single" ? textLayerColumnInfo(spans, pageBounds, layoutMode) : null;
  const splitX = columnInfo?.splitX ?? pageBounds.left + pageBounds.width / 2;
  const columnForPoint = (x: number) => (x >= splitX ? 1 : 0);
  const columnForRect = (rect: DOMRect) => (rect.left + rect.width / 2 >= splitX ? 1 : 0);
  const items = spans
    .map((span, order) => {
      const rect = span.getBoundingClientRect();
      const fullWidth = rect.width > pageBounds.width * 0.66;
      return {
        span,
        order,
        rect,
        fullWidth,
        column: fullWidth ? columnForRect(rect) : columnInfo?.columnFor(rect) ?? columnForRect(rect),
      };
    })
    .filter((item) => item.rect.width > 1 && item.rect.height > 1);
  if (items.length === 0) {
    return [];
  }
  const startColumn = columnInfo?.columnForPoint(gesture.startX) ?? columnForPoint(gesture.startX);
  const endColumn = columnInfo?.columnForPoint(gesture.endX) ?? columnForPoint(gesture.endX);
  const start = closestSpanToPoint(items, gesture.startX, gesture.startY, startColumn);
  const end = closestSpanToPoint(items, gesture.endX, gesture.endY, endColumn);
  if (!start || !end) {
    return [];
  }
  if (!columnInfo) {
    return spanRangeWithinVisualLines(items, start, end, { gesture, fullLinesForVerticalDrag: true });
  }
  if (startColumn === endColumn) {
    const columnItems = items
      .filter((item) => item.column === startColumn && !item.fullWidth)
      .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left || a.order - b.order);
    const columnStart = closestSpanToPoint(columnItems, gesture.startX, gesture.startY, startColumn);
    const columnEnd = closestSpanToPoint(columnItems, gesture.endX, gesture.endY, endColumn);
    if (!columnStart || !columnEnd) {
      return [];
    }
    return spanRangeWithinVisualLines(columnItems, columnStart, columnEnd);
  }

  const selected = items.filter((item) => {
    if (item.fullWidth) {
      return false;
    }
    if (startColumn === 0 && endColumn === 1) {
      return (item.column === 0 && item.order >= start.order) || (item.column === 1 && item.order <= end.order);
    }
    if (startColumn === 1 && endColumn === 0) {
      return (item.column === 1 && item.order >= start.order) || (item.column === 0 && item.order <= end.order);
    }
    return false;
  });
  return selected.map(({ span, order, rect }) => ({ span, order, rect }));
}

export function joinSelectedSpanTexts(spans: HTMLElement[]) {
  let output = "";
  for (const span of spans) {
    const raw = (span.dataset.text ?? "").trim();
    if (!raw) {
      continue;
    }
    if (!output) {
      output = raw;
      continue;
    }
    if (/[A-Za-z]-$/.test(output.trimEnd()) && /^[A-Za-z]/.test(raw)) {
      output = `${output.trimEnd().slice(0, -1)}${raw}`;
    } else if (/^[,.;:!?%)}\]]/.test(raw)) {
      output += raw;
    } else {
      output += ` ${raw}`;
    }
  }
  return cleanSelectedText(output);
}

export function mergeSelectionRects(rects: HighlightRect[]) {
  const sorted = rects
    .slice()
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const merged: HighlightRect[] = [];
  for (const rect of sorted) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      Math.abs(previous.y - rect.y) <= Math.max(3, Math.min(previous.height, rect.height) * 0.35) &&
      Math.abs(previous.height - rect.height) <= Math.max(4, Math.max(previous.height, rect.height) * 0.4) &&
      rect.x <= previous.x + previous.width + 10
    ) {
      const right = Math.max(previous.x + previous.width, rect.x + rect.width);
      const bottom = Math.max(previous.y + previous.height, rect.y + rect.height);
      previous.x = Math.min(previous.x, rect.x);
      previous.y = Math.min(previous.y, rect.y);
      previous.width = right - previous.x;
      previous.height = bottom - previous.y;
    } else {
      merged.push({ ...rect });
    }
  }
  return merged;
}

export function selectionFromTextLayer(
  page: HTMLElement,
  selection: Selection | null,
  rangeRects: DOMRect[],
  gesture?: TextSelectionGesture,
  layoutMode: DocumentTextLayoutMode | "auto" = "auto",
): SelectionToolbar | null {
  const spans = Array.from(page.querySelectorAll<HTMLElement>(".text-layer [data-text]"));
  if (spans.length === 0 || (rangeRects.length === 0 && !gesture)) {
    return null;
  }
  const pageBounds = page.getBoundingClientRect();
  const columnInfo = layoutMode !== "single" ? textLayerColumnInfo(spans, pageBounds, layoutMode) : null;
  const anchorSpan = closestTextLayerSpan(selection?.anchorNode ?? null);
  const anchorColumn = columnInfo && anchorSpan ? columnInfo.columnFor(anchorSpan.getBoundingClientRect()) : null;
  const lockedColumn = columnInfo && anchorColumn !== null ? anchorColumn : null;
  const gestureSpans = gesture && gesture.pageElement === page ? selectedSpansFromGesture(page, spans, gesture, layoutMode) : [];
  const selectedSpans = (gestureSpans.length
    ? gestureSpans
    : spans
        .map((span, order) => ({ span, order, rect: span.getBoundingClientRect() }))
        .filter(({ rect }) => {
          if (rect.width <= 1 || rect.height <= 1) {
            return false;
          }
          if (lockedColumn !== null && columnInfo && !columnInfo.isFullWidth(rect) && columnInfo.columnFor(rect) !== lockedColumn) {
            return false;
          }
          const area = rect.width * rect.height;
          return rangeRects.some((rangeRect) => {
            const intersection = rectIntersectionArea(rect, rangeRect);
            return intersection > Math.min(area, rangeRect.width * rangeRect.height) * 0.08;
          });
        }))
    .sort((a, b) => a.order - b.order);
  if (selectedSpans.length === 0) {
    return null;
  }
  const text = joinSelectedSpanTexts(selectedSpans.map((item) => item.span));
  if (text.length < 2) {
    return null;
  }
  const rects = mergeSelectionRects(
    selectedSpans.map(({ rect }) => ({
      x: Math.max(0, Math.round((rect.left - pageBounds.left) * 10) / 10),
      y: Math.max(0, Math.round((rect.top - pageBounds.top) * 10) / 10),
      width: Math.max(1, Math.round(rect.width * 10) / 10),
      height: Math.max(1, Math.round(rect.height * 10) / 10),
      basisWidth: Math.round(pageBounds.width * 10) / 10,
      basisHeight: Math.round(pageBounds.height * 10) / 10,
    })),
  );
  if (rects.length === 0) {
    return null;
  }
  const left = Math.min(...selectedSpans.map((item) => item.rect.left));
  const top = Math.min(...selectedSpans.map((item) => item.rect.top));
  const right = Math.max(...selectedSpans.map((item) => item.rect.right));
  return {
    text,
    page: Number(page.dataset.page ?? "1"),
    x: (left + right) / 2,
    y: Math.max(72, top - 46),
    rects,
  };
}


export function pdfItemTextBoxes(
  items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }>,
  viewport: { width: number; height: number; transform: number[] },
  scale: number,
) {
  const util = (pdfjsLib as unknown as { Util: { transform: (a: number[], b: number[]) => number[] } }).Util;
  const boxes: TextLayerBox[] = [];
  for (const item of items) {
    const raw = (item.str ?? "").trim();
    if (!raw) {
      continue;
    }
    const transform = item.transform ? util.transform(viewport.transform, item.transform) : [1, 0, 0, 1, 0, 0];
    const fontHeight = Math.max(8, Math.hypot(transform[2], transform[3]));
    const fallbackWidth = Math.max(8, raw.length * fontHeight * 0.52);
    boxes.push({
      text: raw,
      start: 0,
      end: 0,
      rect: {
        left: transform[4],
        top: transform[5] - fontHeight,
        width: typeof item.width === "number" && item.width > 0 ? item.width * scale : fallbackWidth,
        height: fontHeight * 1.25,
      },
      fontSize: fontHeight,
      fontName: item.fontName ?? "",
    });
  }
  return boxes;
}

export function inferTextLayoutModeFromBoxes(boxes: TextLayerBox[]): DocumentTextLayoutMode {
  return inferPageTextLayoutFromBoxes(boxes).mode;
}

export function inferPageTextLayoutFromBoxes(boxes: TextLayerBox[]): PageTextLayoutInference {
  const lines = textLinesFromBoxes(boxes, "single");
  if (lines.length < 10) {
    return { mode: "single", confidence: 0.52, reason: "too few text lines for a confident column split" };
  }
  const boxLeft = quantileNumber(boxes.map((box) => box.rect.left), 0.02);
  const boxRight = quantileNumber(boxes.map((box) => box.rect.left + box.rect.width), 0.98);
  const minLeft = Math.min(boxLeft, Math.min(...lines.map((line) => line.rect.left)));
  const maxRight = Math.max(boxRight, Math.max(...lines.map(lineRight)));
  const span = Math.max(1, maxRight - minLeft);
  const contentTop = Math.min(...lines.map((line) => line.rect.top));
  const contentBottom = Math.max(...lines.map(lineBottom));
  const contentHeight = Math.max(1, contentBottom - contentTop);
  const fontMedian = medianNumber(lines.map((line) => line.fontSize).filter((size) => size > 0));
  const narrowLimit = span * 0.68;
  const candidateLines = lines.filter((line) => {
    const text = line.text.trim();
    const center = lineCenterX(line);
    const y = lineCenterY(line);
    const widthRatio = line.rect.width / span;
    const topRatio = (y - contentTop) / contentHeight;
    const topDisplayText = topRatio < 0.34 && line.fontSize > Math.max(fontMedian * 1.28, fontMedian + 2.4);
    const centeredHeader = topRatio < 0.28 && widthRatio > 0.48 && Math.abs(center - (minLeft + span / 2)) < span * 0.18;
    return (
      text.length >= 3 &&
      line.rect.width >= Math.max(22, line.fontSize * 2.6) &&
      line.rect.width < narrowLimit &&
      center > minLeft + span * 0.04 &&
      center < maxRight - span * 0.04 &&
      !topDisplayText &&
      !centeredHeader
    );
  });
  const lowerStart = contentTop + contentHeight * 0.30;
  const lowerCandidateLines = candidateLines.filter((line) => lineCenterY(line) >= lowerStart);
  const lowerBodyLines =
    lowerCandidateLines.length >= Math.min(8, candidateLines.length) ? lowerCandidateLines : candidateLines;
  if (lowerBodyLines.length < 8) {
    return {
      mode: "single",
      confidence: boxes.length > 80 ? 0.62 : 0.55,
      reason: `few body-column candidates (${lowerBodyLines.length})`,
    };
  }

  function evaluateCandidates(bodyLines: TextLine[], label: string) {
    const centers = bodyLines.map(lineCenterX).sort((a, b) => a - b);
    let bestGap = 0;
    let splitX = minLeft + span / 2;
    for (let index = 1; index < centers.length; index += 1) {
      const gap = centers[index] - centers[index - 1];
      const candidateSplit = (centers[index - 1] + centers[index]) / 2;
      const splitRatio = (candidateSplit - minLeft) / span;
      if (splitRatio >= 0.32 && splitRatio <= 0.68 && gap > bestGap) {
        bestGap = gap;
        splitX = candidateSplit;
      }
    }
    const leftLines = bodyLines.filter((line) => lineCenterX(line) < splitX);
    const rightLines = bodyLines.length - leftLines.length;
    const leftCount = leftLines.length;
    const rightCount = rightLines;
    const balance = rightCount > 0 ? Math.min(leftCount, rightCount) / Math.max(leftCount, rightCount) : 0;
    const rowTolerance = Math.max(6, fontMedian * 0.85);
    const rows: Array<{ top: number; bottom: number; columns: Set<number> }> = [];
    for (const line of [...bodyLines].sort((a, b) => lineCenterY(a) - lineCenterY(b))) {
      const y = lineCenterY(line);
      const column = lineCenterX(line) < splitX ? 0 : 1;
      let row = rows.find((item) => y >= item.top - rowTolerance && y <= item.bottom + rowTolerance);
      if (!row) {
        row = { top: line.rect.top, bottom: lineBottom(line), columns: new Set<number>() };
        rows.push(row);
      }
      row.top = Math.min(row.top, line.rect.top);
      row.bottom = Math.max(row.bottom, lineBottom(line));
      row.columns.add(column);
    }
    const pairedRows = rows.filter((row) => row.columns.size >= 2).length;
    const pairedRatio = rows.length ? pairedRows / rows.length : 0;
    const bandTop = Math.min(...bodyLines.map((line) => line.rect.top));
    const bandBottom = Math.max(...bodyLines.map(lineBottom));
    const verticalCoverage = (bandBottom - bandTop) / contentHeight;
    const bodyBoxes = bodyLines.flatMap((line) => line.boxes).filter((box) => {
      const text = box.text.trim();
      if (!text || box.rect.width <= 1 || box.rect.height <= 1) {
        return false;
      }
      const center = box.rect.left + box.rect.width / 2;
      const y = box.rect.top + box.rect.height / 2;
      return (
        y >= bandTop - rowTolerance * 2 &&
        y <= bandBottom + rowTolerance * 2 &&
        center > minLeft + span * 0.035 &&
        center < maxRight - span * 0.035 &&
        box.fontSize <= Math.max(fontMedian * 1.65, fontMedian + 5)
      );
    });
    const boxCenters = bodyBoxes.map((box) => box.rect.left + box.rect.width / 2).sort((a, b) => a - b);
    let bestBoxGap = 0;
    for (let index = 1; index < boxCenters.length; index += 1) {
      const gap = boxCenters[index] - boxCenters[index - 1];
      if (gap > bestBoxGap) {
        bestBoxGap = gap;
      }
    }
    const gutterWidth = Math.max(24, span * 0.045);
    const gutterHits = bodyBoxes.filter(
      (box) => box.rect.left <= splitX + gutterWidth / 2 && box.rect.left + box.rect.width >= splitX - gutterWidth / 2,
    ).length;
    const gutterDensity = bodyBoxes.length ? gutterHits / bodyBoxes.length : 1;
    const medianLineWidth = medianNumber(bodyLines.map((line) => line.rect.width)) / span;
    const hasLineColumnGap = bestGap > Math.max(42, span * 0.08);
    const hasHugeLineGap = bestGap > Math.max(72, span * 0.135);
    const hasBoxColumnGap = bestBoxGap > Math.max(30, span * 0.055);
    const hasUsefulGutter = gutterDensity < 0.24 || (hasHugeLineGap && balance >= 0.5 && gutterDensity < 0.3);
    const hasPairedRows = pairedRows >= 3 && pairedRatio >= 0.14;
    const hasEnoughSideEvidence = Math.min(leftCount, rightCount) >= 4 || (hasPairedRows && Math.min(leftCount, rightCount) >= 3);
    const hasEnoughVerticalEvidence = verticalCoverage >= 0.18 || pairedRows >= 4 || bodyLines.length >= 16;
    const isBalanced = balance >= 0.34 || (hasPairedRows && balance >= 0.24);
    const narrowEnough = medianLineWidth < 0.56;
    const twoColumn =
      hasEnoughSideEvidence &&
      hasEnoughVerticalEvidence &&
      isBalanced &&
      narrowEnough &&
      hasUsefulGutter &&
      (hasLineColumnGap || hasPairedRows || (hasHugeLineGap && hasBoxColumnGap));
    const lineGapScore = bestGap / Math.max(1, span);
    const boxGapScore = bestBoxGap / Math.max(1, span);
    const twoColumnScore =
      (hasLineColumnGap ? 0.24 : 0) +
      (hasHugeLineGap ? 0.1 : 0) +
      (hasBoxColumnGap ? 0.1 : 0) +
      (hasUsefulGutter ? 0.14 : 0) +
      (hasPairedRows ? Math.min(0.18, pairedRows * 0.035 + pairedRatio * 0.12) : 0) +
      (hasEnoughVerticalEvidence ? 0.08 : 0) +
      (narrowEnough ? 0.08 : 0) +
      Math.min(0.18, balance * 0.18) +
      Math.min(0.1, Math.max(lineGapScore, boxGapScore) * 0.65);
    return {
      label,
      twoColumn,
      score: twoColumnScore,
      leftCount,
      rightCount,
      balance,
      bestGap,
      bestBoxGap,
      gutterDensity,
      pairedRows,
      pairedRatio,
      verticalCoverage,
      bodyLineCount: bodyLines.length,
    };
  }

  const allEvidence = evaluateCandidates(candidateLines, "all");
  const lowerEvidence = evaluateCandidates(lowerBodyLines, "body");
  const evidence = lowerEvidence.score >= allEvidence.score ? lowerEvidence : allEvidence;
  const mode = evidence.twoColumn ? "two-column" : "single";
  const confidence =
    mode === "two-column"
      ? Math.max(0.68, Math.min(0.98, evidence.score))
      : Math.max(0.55, Math.min(0.94, 1 - evidence.score * 0.62 + Math.min(0.06, evidence.gutterDensity)));
  return {
    mode,
    confidence: Math.round(confidence * 100) / 100,
    reason: `${evidence.label} lines ${evidence.leftCount}/${evidence.rightCount}, balance ${evidence.balance.toFixed(2)}, paired ${evidence.pairedRows}, vertical ${(evidence.verticalCoverage * 100).toFixed(1)}%, line gap ${Math.round(evidence.bestGap)}, box gap ${Math.round(evidence.bestBoxGap)}, gutter ${(evidence.gutterDensity * 100).toFixed(1)}%`,
  };
}

export function textLayoutModeFromPdfItems(
  items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }>,
  viewport: { width: number; height: number; transform: number[] },
  scale: number,
): DocumentTextLayoutMode {
  return inferPageTextLayoutFromPdfItems(items, viewport, scale).mode;
}

export function inferPageTextLayoutFromPdfItems(
  items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }>,
  viewport: { width: number; height: number; transform: number[] },
  scale: number,
): PageTextLayoutInference {
  return inferPageTextLayoutFromBoxes(pdfItemTextBoxes(items, viewport, scale));
}

export function textBoxesFromPdfItems(
  items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }>,
  viewport: { width: number; height: number; transform: number[] },
  scale: number,
  layoutMode: DocumentTextLayoutMode | "auto" = "auto",
) {
  const boxes = pdfItemTextBoxes(items, viewport, scale);
  return textAndBoxesFromOrderedLines(textLinesFromBoxes(boxes, layoutMode));
}
