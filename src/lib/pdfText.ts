import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { sliceTextSpan, textOffsetAtX } from "./textSelectionOffsets";
import { readingOrderForLines } from "./pdfReadingOrder";
export const pdfTextExtractionVersion = "regional-layout-v3";
export const pdfTextExtractionVersionKey = (documentId: string) => `pdfTextExtractionVersion:${documentId}`;
import type { HighlightRect } from "../types";

export type PdfTextItem = { str?: string; transform?: number[]; fontName?: string; width?: number; height?: number };

export type PdfTextViewport = { width: number; height: number; transform: number[] };

export type SelectionToolbar = {
  text: string;
  page: number;
  x: number;
  y: number;
  viewportRect?: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
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
  order?: number;
  flowId?: number;
};

export type TextLine = {
  text: string;
  rect: { left: number; top: number; width: number; height: number };
  fontSize: number;
  fontNames: string[];
  boxes: TextLayerBox[];
  flowId?: number;
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

function textBoxRight(box: TextLayerBox) {
  return box.rect.left + box.rect.width;
}

function shouldStartVisualLineCluster(current: TextLayerBox[], box: TextLayerBox) {
  const currentRight = Math.max(...current.map(textBoxRight));
  const gap = box.rect.left - currentRight;
  if (gap <= 0) {
    return false;
  }
  const fontSize = Math.max(...current.map((item) => item.fontSize), box.fontSize, 1);
  // A short equation number beside the next column is still separated by a
  // gutter. Requiring a larger gap for short runs would join the two columns.
  return gap > fontSize * 0.9;
}

export function visualTextLinesFromBoxes(boxes: TextLayerBox[]) {
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
      const tolerance = Math.min(box.rect.height, group.bottom - group.top) * 0.45;
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
      if (shouldStartVisualLineCluster(current, box)) {
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
          gap <= Math.min(previous.fontSize, box.fontSize) * 0.12 ||
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
  return lines.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
}

export function textLinesFromBoxes(boxes: TextLayerBox[], _layoutMode: DocumentTextLayoutMode | "auto" = "auto") {
  // Stored page-wide classifications are hints only: each region has its own order.
  return readingOrderForLines(visualTextLinesFromBoxes(boxes)).lines;
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
  return textAndBoxesFromOrderedLines(lines).text;
}

export function textAndBoxesFromOrderedLines(lines: TextLine[]) {
  let text = "";
  const boxes: TextLayerBox[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const previous = lines[lineIndex - 1];
    const sameFlow = previous && previous.flowId === line.flowId;
    const joinedHyphen = sameFlow && /[A-Za-z]-$/.test(previous.text.trimEnd()) && /^[A-Za-z]/.test(line.text.trimStart());
    if (joinedHyphen) {
      text = text.slice(0, -1);
      if (boxes.length) boxes[boxes.length - 1].end = Math.min(boxes[boxes.length - 1].end, text.length);
    } else if (previous) {
      text += sameFlow ? "\n" : "\n\n";
    }
    const offset = text.length;
    let cursor = 0;
    for (const box of line.boxes) {
      const raw = box.text.trim();
      if (!raw) continue;
      const match = line.text.indexOf(raw, cursor);
      const start = match >= 0 ? match : cursor;
      boxes.push({ ...box, text: raw, start: offset + start, end: offset + start + raw.length, flowId: line.flowId });
      cursor = start + raw.length;
    }
    text += line.text;
  }
  return { text, boxes };
}

export function dehyphenateLineBreaks(text: string) {
  return text.split(/\n{2,}/).map((block) => block
    .replace(/([A-Za-z])-[ \t]*\n[ \t]*([A-Za-z])/g, "$1$2")
    .replace(/\s+/g, " ").trim()).filter(Boolean).join("\n\n");
}

function pdfTextItemPosition(
  item: { str?: string; transform?: number[]; width?: number; height?: number },
  viewport: { transform: number[] },
) {
  const util = (pdfjsLib as unknown as { Util: { transform: (a: number[], b: number[]) => number[] } }).Util;
  const transform = item.transform ? util.transform(viewport.transform, item.transform) : [1, 0, 0, 1, 0, 0];
  return {
    x: transform[4],
    y: transform[5],
    width: typeof item.width === "number" ? item.width : 0,
    height: typeof item.height === "number" ? item.height : Math.max(0, Math.hypot(transform[2], transform[3])),
  };
}

function isMostlyHorizontalTextTransform(transform: number[]) {
  const baselineLength = Math.hypot(transform[0], transform[1]);
  if (baselineLength <= 0) {
    return true;
  }
  return Math.abs(transform[1]) / baselineLength <= 0.26;
}

function normalizeFormulaToken(token: string) {
  return token
    .replace(/\u001a/g, "{")
    .replace(/\u2212/g, "-")
    .replace(/\u00d7/g, "x")
    .replace(/\u22c5|\u00b7/g, "@")
    .trim();
}

function serializeFormulaItems(
  entries: Array<{
    str: string;
    x: number;
    y: number;
    width: number;
    height: number;
  }>,
) {
  let output = "";
  let previous: (typeof entries)[number] | null = null;
  let notEqualOverlay = false;
  for (const entry of entries) {
    const raw = entry.str;
    if (!raw.trim()) {
      continue;
    }
    if (raw === "\u0338") {
      notEqualOverlay = true;
      continue;
    }
    let token = normalizeFormulaToken(raw);
    if (!token) {
      continue;
    }
    if (notEqualOverlay && token === "=") {
      token = "!=";
      notEqualOverlay = false;
    }
    const previousRight = previous ? previous.x + previous.width : entry.x;
    const gap = previous ? entry.x - previousRight : 0;
    const looksSubscript =
      previous &&
      /^[A-Za-z0-9]+$/.test(token) &&
      previous.height > 0 &&
      entry.height > 0 &&
      entry.height <= previous.height * 0.82 &&
      Math.abs(entry.y - previous.y) > 0.4 &&
      gap <= Math.max(4, previous.height * 0.45);
    if (!output) {
      output = token;
    } else if (looksSubscript) {
      output += `_${token}`;
    } else if (/^[,.;:!?%)\]}]$/.test(token) || token.startsWith("_")) {
      output += token;
    } else if (/^[({\[]$/.test(token) || /[({\[]$/.test(output)) {
      output += token;
    } else if (/^(=|!=|-|\+|@|x|\/)$/.test(token) || /(?:=|!=|-|\+|@|x|\/)$/.test(output)) {
      output += ` ${token}`;
    } else if (gap > Math.max(2, Math.min(entry.height || 8, previous?.height || 8) * 0.22)) {
      output += ` ${token}`;
    } else {
      output += token;
    }
    previous = entry;
  }
  return output.replace(/\s+/g, " ").replace(/\{\s+/g, "{ ").trim();
}

export function formulaTextFromPdfItems(
  items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }>,
  viewport: { width: number; height: number; transform: number[] },
) {
  const entries = items.map((item, order) => ({
    order,
    str: item.str ?? "",
    fontName: item.fontName ?? "",
    ...pdfTextItemPosition(item, viewport),
  }));
  const equationNumbers = entries.filter((entry) => /^\(\d+\)$/.test(entry.str.trim()));
  const formulas: string[] = [];
  const seen = new Set<string>();
  for (const equationNumber of equationNumbers) {
    const startMarker = entries
      .filter((entry) => {
        if (entry.order >= equationNumber.order || entry.str.trim()) {
          return false;
        }
        if (entry.x < 48 || entry.x > equationNumber.x) {
          return false;
        }
        return Math.abs(entry.y - equationNumber.y) <= 34;
      })
      .sort((a, b) => Math.abs(a.y - equationNumber.y) - Math.abs(b.y - equationNumber.y) || a.order - b.order)[0];
    const band = entries
      .filter((entry) => {
        if (entry.order >= equationNumber.order || !entry.str.trim()) {
          return false;
        }
        if (startMarker && entry.order <= startMarker.order) {
          return false;
        }
        if (entry.x < 48 || entry.x > equationNumber.x + 4) {
          return false;
        }
        return Math.abs(entry.y - equationNumber.y) <= 34;
      })
      .slice(-48);
    const formula = serializeFormulaItems(band);
    if (
      formula &&
      formula.length >= 6 &&
      /[=]|dLd|J_|\\partial|∂|sigma|softmax|exp|erf|Phi|Φ/.test(formula) &&
      !seen.has(formula)
    ) {
      seen.add(formula);
      formulas.push(`${formula} ${equationNumber.str.trim()}`);
    }
  }
  return formulas;
}

export function pageTextFromPdfItems(
  items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }>,
  viewport: { width: number; height: number; transform: number[] },
  scale: number,
  layoutMode: DocumentTextLayoutMode | "auto" = "auto",
) {
  const { text } = textBoxesFromPdfItems(items, viewport, scale, layoutMode);
  const dehyphenated = dehyphenateLineBreaks(text);
  return dehyphenated || items.map((item) => item.str ?? "").join(" ").replace(/\s+/g, " ").trim();
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
  const lines = visualTextLinesFromBoxes(pdfItemTextBoxes(items, viewport, scale))
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
  if (spans.some((span) => span.dataset.flowId !== undefined)) {
    const items = spans.map((span, order) => ({ span, order, rect: span.getBoundingClientRect(), column: 0, fullWidth: false }))
      .filter((item) => item.rect.width > 1 && item.rect.height > 1);
    const start = closestSpanToPoint(items, gesture.startX, gesture.startY);
    const end = closestSpanToPoint(items, gesture.endX, gesture.endY);
    if (!start || !end) return [];
    if (start.span.dataset.flowId === end.span.dataset.flowId) {
      return spanRangeWithinVisualLines(items.filter((item) => item.span.dataset.flowId === start.span.dataset.flowId), start, end);
    }
    return items.filter((item) => item.order >= Math.min(start.order, end.order) && item.order <= Math.max(start.order, end.order));
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
    return spanRangeWithinVisualLines(items, start, end, { gesture, fullLinesForVerticalDrag: false });
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

export function joinSelectedSpanTexts(spans: HTMLElement[], texts?: string[]) {
  let output = "";
  for (const [index, span] of spans.entries()) {
    const raw = (texts?.[index] ?? span.dataset.text ?? "").trim();
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
  const hasFlows = spans.some((span) => span.dataset.flowId !== undefined);
  const columnInfo = !hasFlows && layoutMode !== "single" ? textLayerColumnInfo(spans, pageBounds, layoutMode) : null;
  const anchorSpan = closestTextLayerSpan(selection?.anchorNode ?? null);
  const anchorColumn = columnInfo && anchorSpan ? columnInfo.columnFor(anchorSpan.getBoundingClientRect()) : null;
  const lockedColumn = columnInfo && anchorColumn !== null ? anchorColumn : null;
  const gestureSpans = gesture && gesture.pageElement === page ? selectedSpansFromGesture(page, spans, gesture, layoutMode) : [];
  let selectedSpans = (gestureSpans.length
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
  let selectedTexts: string[] | undefined;
  if (gesture && gestureSpans.length) {
    const candidates = selectedSpans.map((item) => ({ ...item, column: 0, fullWidth: false }));
    const anchor = closestSpanToPoint(candidates, gesture.startX, gesture.startY);
    const focus = closestSpanToPoint(candidates, gesture.endX, gesture.endY);
    if (!anchor || !focus) return null;
    const anchorOffset = textOffsetAtX(anchor.span, gesture.startX);
    const focusOffset = textOffsetAtX(focus.span, gesture.endX);
    const forward = anchor.order < focus.order || (anchor.order === focus.order && anchorOffset <= focusOffset);
    const first = forward ? anchor : focus;
    const last = forward ? focus : anchor;
    const firstOffset = forward ? anchorOffset : focusOffset;
    const lastOffset = forward ? focusOffset : anchorOffset;
    const slices = selectedSpans.flatMap((item) => {
      const length = (item.span.textContent || item.span.dataset.text || "").length;
      const part = sliceTextSpan(item.span, item.order === first.order ? firstOffset : 0, item.order === last.order ? lastOffset : length);
      return part ? [{ ...item, rect: part.rect, text: part.text }] : [];
    });
    selectedSpans = slices;
    selectedTexts = slices.map((item) => item.text);
  }
  const text = joinSelectedSpanTexts(selectedSpans.map((item) => item.span), selectedTexts);
  if (text.length < 1) {
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
    viewportRect: {
      left,
      top,
      right,
      bottom: Math.max(...selectedSpans.map((item) => item.rect.bottom)),
      width: right - left,
      height: Math.max(...selectedSpans.map((item) => item.rect.bottom)) - top,
    },
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
  for (const [order, item] of items.entries()) {
    const raw = (item.str ?? "").trim();
    if (!raw) {
      continue;
    }
    const transform = item.transform ? util.transform(viewport.transform, item.transform) : [1, 0, 0, 1, 0, 0];
    if (!isMostlyHorizontalTextTransform(transform)) {
      continue;
    }
    const fontHeight = Math.max(1, Math.hypot(transform[2], transform[3]));
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
      order,
    });
  }
  return boxes;
}

export function inferTextLayoutModeFromBoxes(boxes: TextLayerBox[]): DocumentTextLayoutMode {
  return inferPageTextLayoutFromBoxes(boxes).mode;
}

export function inferPageTextLayoutFromBoxes(boxes: TextLayerBox[]): PageTextLayoutInference {
  const layout = readingOrderForLines(visualTextLinesFromBoxes(boxes));
  return {
    mode: layout.columns > 1 ? "two-column" : "single",
    confidence: layout.columns > 1 ? 0.95 : boxes.length > 30 ? 0.9 : 0.6,
    reason: `regional reading order: ${layout.columns} columns, ${layout.flows} regions`,
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
  return inferPageTextLayoutFromBoxes(pdfItemTextBoxes(items, unscaledViewport(viewport, scale), 1));
}

function unscaledViewport(viewport: PdfTextViewport, scale: number): PdfTextViewport {
  return {
    width: viewport.width / scale,
    height: viewport.height / scale,
    transform: viewport.transform.map((value) => Math.round(value / scale * 1e6) / 1e6),
  };
}

export function textBoxesFromPdfItems(
  items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }>,
  viewport: { width: number; height: number; transform: number[] },
  scale: number,
  layoutMode: DocumentTextLayoutMode | "auto" = "auto",
) {
  const boxes = pdfItemTextBoxes(items, unscaledViewport(viewport, scale), 1);
  const ordered = textAndBoxesFromOrderedLines(textLinesFromBoxes(boxes, layoutMode));
  return { text: ordered.text, boxes: ordered.boxes.map((box) => ({ ...box, fontSize: box.fontSize * scale,
    rect: { left: box.rect.left * scale, top: box.rect.top * scale, width: box.rect.width * scale, height: box.rect.height * scale } })) };
}
