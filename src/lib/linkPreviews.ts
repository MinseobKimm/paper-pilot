import type { PageRecord } from "../types";
import { cleanOutlineTitle, outlineDomToken, type OutlineRow } from "./outlines";
import { textBoxesFromPdfItems, type TextLayerBox } from "./pdfText";
import { normalizeComparable } from "./textUtils";
import { uiStrings, type UiStrings } from "./uiStrings";

export type PdfOutlineItem = {
  title?: string;
  dest?: unknown;
  items?: PdfOutlineItem[];
};

export type ReferencePreviewKind =
  | "link"
  | "citation"
  | "equation"
  | "figure"
  | "table"
  | "section"
  | "page"
  | "algorithm"
  | "theorem"
  | "definition"
  | "remark";

export type PdfLinkPreviewTarget = {
  id: string;
  sourcePage: number;
  title: string;
  kind: "internal" | "external";
  previewKind: ReferencePreviewKind;
  rect: { left: number; top: number; width: number; height: number };
  url?: string;
  dest?: unknown;
  targetPage?: number;
  targetText?: string;
  excerpt?: string;
  referenceText?: string;
};

export type LinkPreviewState =
  | {
      kind: "internal";
      sourcePage: number;
      targetPage: number;
      title: string;
      imageDataUrl: string;
      previewMode: "page" | "region";
      previewKind: ReferencePreviewKind;
      targetText?: string;
      excerpt?: string;
      referenceText?: string;
    }
  | {
      kind: "external";
      sourcePage: number;
      title: string;
      url: string;
      summary: string;
    };

type PreviewPdfPage = {
  getViewport(options: { scale: number }): { width: number; height: number; transform: number[] };
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
  getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }> }>;
};

export type PreviewPdfDocument = {
  numPages: number;
  getPage(pageNumber: number): Promise<PreviewPdfPage>;
  getDestination?(dest: string): Promise<unknown[] | null>;
  getPageIndex?(ref: unknown): Promise<number>;
};

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function flexibleTextPattern(value: string) {
  return normalizeComparable(value)
    .split(/\s+/)
    .filter(Boolean)
    .map(escapeRegExp)
    .join("\\s+");
}

function previewReferenceNumber(target: PdfLinkPreviewTarget) {
  return (
    target.title.match(/([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/i)?.[1] ??
    target.referenceText?.match(/([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/i)?.[1] ??
    target.targetText?.match(/([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/i)?.[1] ??
    ""
  );
}

function isStatementPreviewKind(kind: ReferencePreviewKind) {
  return kind === "theorem" || kind === "definition" || kind === "remark";
}

function statementLabelsForKind(kind: ReferencePreviewKind) {
  if (kind === "definition") {
    return ["Definition", "Def\\.?"];
  }
  if (kind === "remark") {
    return ["Remark", "Rem\\.?"];
  }
  if (kind === "theorem") {
    return ["Theorem", "Lemma", "Proposition", "Corollary"];
  }
  return [];
}

function statementLabelFromTarget(target: PdfLinkPreviewTarget) {
  const source = target.targetText || target.referenceText || target.title;
  const match = source.match(/\b(Theorem|Lemma|Proposition|Corollary|Definition|Def\.?|Remark|Rem\.?)\b/i);
  return match?.[1] ?? "";
}

function statementLabelPattern(kind: ReferencePreviewKind, preferredLabel = "") {
  const labels = statementLabelsForKind(kind);
  if (labels.length === 0) {
    return "";
  }
  const normalized = preferredLabel.replace(/\.$/, "").toLowerCase();
  const exact =
    normalized === "def"
      ? "(?:Definition|Def\\.?)"
      : normalized === "rem"
        ? "(?:Remark|Rem\\.?)"
        : labels.find((label) => label.replace(/\\\.\?$/, "").toLowerCase() === normalized);
  return exact || labels.join("|");
}

function firstStatementLabelRange(text: string, kind: ReferencePreviewKind, labelNumber: string, preferredLabel = "") {
  if (!isStatementPreviewKind(kind) || !labelNumber) {
    return null;
  }
  const labelPattern = statementLabelPattern(kind, preferredLabel);
  if (!labelPattern) {
    return null;
  }
  const regex = new RegExp(`\\b(?:${labelPattern})\\s*${escapeRegExp(labelNumber)}\\b\\s*[:.(]?`, "i");
  const match = regex.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}

function targetRangeForRegionPreview(text: string, target: PdfLinkPreviewTarget) {
  if (isStatementPreviewKind(target.previewKind)) {
    const statementRange = firstStatementLabelRange(
      text,
      target.previewKind,
      previewReferenceNumber(target),
      statementLabelFromTarget(target),
    );
    if (statementRange) {
      return statementRange;
    }
  }

  const exactCandidates = [target.targetText, target.referenceText, target.title].filter(Boolean) as string[];
  for (const candidate of exactCandidates) {
    const pattern = flexibleTextPattern(candidate);
    if (!pattern) {
      continue;
    }
    const match = new RegExp(pattern, "i").exec(text);
    if (match) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }

  const number = previewReferenceNumber(target);
  if (!number) {
    return null;
  }
  const escaped = escapeRegExp(number);
  const patterns =
    target.previewKind === "equation"
      ? [new RegExp(`\\(\\s*${escaped}\\s*\\)`, "i"), new RegExp(`(?:eq\\.?|equation)\\s*\\(?\\s*${escaped}\\s*\\)?`, "i")]
      : target.previewKind === "figure"
        ? [new RegExp(`(?:fig\\.?|figure)\\s*${escaped}`, "i")]
        : target.previewKind === "table"
          ? [new RegExp(`table\\s*${escaped}`, "i")]
          : target.previewKind === "citation"
            ? [new RegExp(`\\[\\s*${escaped}\\s*\\]`, "i"), new RegExp(`(?:^|\\s)${escaped}\\s*[.)]\\s+[A-Z]`, "i")]
            : [new RegExp(escaped, "i")];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      return { start: match.index, end: match.index + match[0].length };
    }
  }
  return null;
}

function cropRectForRegionPreview(
  boxes: TextLayerBox[],
  range: { start: number; end: number },
  kind: ReferencePreviewKind,
  viewportWidth: number,
  viewportHeight: number,
) {
  const matchRect = rectForTextRange(boxes, range.start, range.end);
  if (!matchRect) {
    return null;
  }
  const centerY = matchRect.top + matchRect.height / 2;
  const lineHeight = Math.max(12, matchRect.height);
  const bandTop =
    kind === "citation" || isStatementPreviewKind(kind)
      ? matchRect.top - lineHeight * 0.8
      : matchRect.top - lineHeight * 0.9;
  const bandBottom =
    kind === "citation" || isStatementPreviewKind(kind)
      ? matchRect.top + lineHeight * 3.4
      : kind === "equation"
        ? matchRect.top + lineHeight * 1.9
        : matchRect.top + lineHeight * 2.2;
  const lineTolerance = Math.max(kind === "equation" ? 28 : 20, lineHeight * (kind === "equation" ? 1.8 : 1.4));
  const selected = boxes.filter((box) => {
    const boxCenterY = box.rect.top + box.rect.height / 2;
    if (kind === "equation") {
      return Math.abs(boxCenterY - centerY) <= lineTolerance;
    }
    return boxCenterY >= bandTop && boxCenterY <= bandBottom;
  });
  const basis = selected.length ? selected : boxes.filter((box) => box.end > range.start && box.start < range.end);
  if (!basis.length) {
    return null;
  }
  const left = Math.min(...basis.map((box) => box.rect.left));
  const top = Math.min(...basis.map((box) => box.rect.top));
  const right = Math.max(...basis.map((box) => box.rect.left + box.rect.width));
  const bottom = Math.max(...basis.map((box) => box.rect.top + box.rect.height));
  const padX = kind === "equation" ? 34 : 24;
  const padY = kind === "equation" ? 20 : 18;
  const x = clampNumber(left - padX, 0, viewportWidth);
  const y = clampNumber(top - padY, 0, viewportHeight);
  const width = clampNumber(right - left + padX * 2, 24, viewportWidth - x);
  const height = clampNumber(bottom - top + padY * 2, 24, viewportHeight - y);
  return { x, y, width, height };
}

function isInkPixel(data: Uint8ClampedArray, offset: number) {
  const alpha = data[offset + 3];
  if (alpha < 24) {
    return false;
  }
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  const brightness = (red + green + blue) / 3;
  return brightness < 246 && (red < 242 || green < 242 || blue < 242);
}

function clampCropRect(
  rect: { x: number; y: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
) {
  const x = clampNumber(Math.floor(rect.x), 0, Math.max(0, viewportWidth - 1));
  const y = clampNumber(Math.floor(rect.y), 0, Math.max(0, viewportHeight - 1));
  const width = clampNumber(Math.ceil(rect.width), 1, viewportWidth - x);
  const height = clampNumber(Math.ceil(rect.height), 1, viewportHeight - y);
  return { x, y, width, height };
}

function padCropRect(
  rect: { x: number; y: number; width: number; height: number },
  padX: number,
  padY: number,
  viewportWidth: number,
  viewportHeight: number,
) {
  return clampCropRect(
    {
      x: rect.x - padX,
      y: rect.y - padY,
      width: rect.width + padX * 2,
      height: rect.height + padY * 2,
    },
    viewportWidth,
    viewportHeight,
  );
}

function inkBoundsInRect(
  image: ImageData,
  rect: { x: number; y: number; width: number; height: number },
) {
  const area = clampCropRect(rect, image.width, image.height);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  for (let y = area.y; y < area.y + area.height; y += 1) {
    const rowOffset = y * image.width * 4;
    for (let x = area.x; x < area.x + area.width; x += 1) {
      if (isInkPixel(image.data, rowOffset + x * 4)) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

function rowInkCounts(
  image: ImageData,
  rect: { x: number; y: number; width: number; height: number },
) {
  const area = clampCropRect(rect, image.width, image.height);
  const counts = new Map<number, number>();
  for (let y = area.y; y < area.y + area.height; y += 1) {
    const rowOffset = y * image.width * 4;
    let count = 0;
    for (let x = area.x; x < area.x + area.width; x += 1) {
      if (isInkPixel(image.data, rowOffset + x * 4)) {
        count += 1;
      }
    }
    counts.set(y, count);
  }
  return counts;
}

function rowBandsFromCounts(
  counts: Map<number, number>,
  yStart: number,
  yEnd: number,
  threshold: number,
  allowedGap: number,
) {
  const bands: Array<{ top: number; bottom: number; peak: number }> = [];
  let current: { top: number; bottom: number; peak: number } | null = null;
  let gap = 0;
  for (let y = yStart; y <= yEnd; y += 1) {
    const count = counts.get(y) ?? 0;
    if (count >= threshold) {
      if (!current) {
        current = { top: y, bottom: y, peak: count };
      } else {
        current.bottom = y;
        current.peak = Math.max(current.peak, count);
      }
      gap = 0;
    } else if (current) {
      gap += 1;
      if (gap > allowedGap) {
        current.bottom = Math.max(current.top, current.bottom - gap);
        bands.push(current);
        current = null;
        gap = 0;
      }
    }
  }
  if (current) {
    current.bottom = Math.max(current.top, current.bottom - gap);
    bands.push(current);
  }
  return bands;
}

function equationVisualCropRect(
  image: ImageData,
  anchorRect: { left: number; top: number; width: number; height: number },
  viewportWidth: number,
  viewportHeight: number,
) {
  const centerY = Math.round(anchorRect.top + anchorRect.height / 2);
  const search = Math.max(70, anchorRect.height * 5);
  const yStart = Math.max(0, Math.floor(centerY - search));
  const yEnd = Math.min(image.height - 1, Math.ceil(centerY + search));
  const counts = rowInkCounts(image, { x: 0, y: yStart, width: image.width, height: yEnd - yStart + 1 });
  const threshold = Math.max(3, Math.floor(image.width * 0.0025));
  let seed = centerY;
  let seedScore = -1;
  for (let y = yStart; y <= yEnd; y += 1) {
    const count = counts.get(y) ?? 0;
    if (count < threshold) {
      continue;
    }
    const score = count - Math.abs(y - centerY) * 0.8;
    if (score > seedScore) {
      seed = y;
      seedScore = score;
    }
  }
  if (seedScore < 0) {
    return null;
  }

  const allowedGap = Math.max(10, Math.round(anchorRect.height * 0.9));
  const maxSpan = Math.max(170, anchorRect.height * 9);
  let top = seed;
  let bottom = seed;
  let gap = 0;
  for (let y = seed - 1; y >= Math.max(0, seed - maxSpan); y -= 1) {
    if ((counts.get(y) ?? 0) >= threshold) {
      top = y;
      gap = 0;
    } else {
      gap += 1;
      if (gap > allowedGap) {
        break;
      }
    }
  }
  gap = 0;
  for (let y = seed + 1; y <= Math.min(image.height - 1, seed + maxSpan); y += 1) {
    if ((counts.get(y) ?? 0) >= threshold) {
      bottom = y;
      gap = 0;
    } else {
      gap += 1;
      if (gap > allowedGap) {
        break;
      }
    }
  }

  const bounds = inkBoundsInRect(image, { x: 0, y: top, width: image.width, height: bottom - top + 1 });
  if (!bounds) {
    return null;
  }
  return padCropRect(bounds, 34, 20, viewportWidth, viewportHeight);
}

function textBlockVisualCropRect(
  image: ImageData,
  anchorRect: { left: number; top: number; width: number; height: number },
  kind: ReferencePreviewKind,
  viewportWidth: number,
  viewportHeight: number,
) {
  const line = Math.max(14, anchorRect.height);
  const lines =
    kind === "citation" ? 5 : kind === "algorithm" || isStatementPreviewKind(kind) ? 7 : 3;
  const search = {
    x: 0,
    y: Math.max(0, anchorRect.top - line * 0.8),
    width: viewportWidth,
    height: Math.min(viewportHeight, line * lines),
  };
  const bounds = inkBoundsInRect(image, search);
  return bounds ? padCropRect(bounds, 22, 16, viewportWidth, viewportHeight) : null;
}

function captionObjectVisualCropRect(
  image: ImageData,
  anchorRect: { left: number; top: number; width: number; height: number },
  kind: ReferencePreviewKind,
  viewportWidth: number,
  viewportHeight: number,
) {
  const line = Math.max(14, anchorRect.height);
  const look = Math.min(viewportHeight * 0.72, Math.max(360, line * 34));
  const directions = kind === "table" || kind === "algorithm" ? ["below", "above"] : ["above", "below"];
  const threshold = Math.max(3, Math.floor(viewportWidth * 0.0012));
  const bandGap = Math.max(6, Math.round(line * 0.55));
  const clusterGap =
    kind === "figure"
      ? Math.max(52, Math.round(line * 3.2))
      : Math.max(42, Math.round(line * 2.6));

  for (const direction of directions) {
    const y =
      direction === "above"
        ? Math.max(0, anchorRect.top - look)
        : Math.max(0, anchorRect.top - line * 2.6);
    const bottom =
      direction === "above"
        ? Math.min(viewportHeight, anchorRect.top + line * 6.5)
        : Math.min(viewportHeight, anchorRect.top + look);
    const search = { x: 0, y, width: viewportWidth, height: Math.max(1, bottom - y) };
    const counts = rowInkCounts(image, search);
    const bands = rowBandsFromCounts(
      counts,
      Math.floor(search.y),
      Math.floor(search.y + search.height - 1),
      threshold,
      bandGap,
    );
    if (!bands.length) {
      continue;
    }
    const anchorTop = anchorRect.top - line * 0.7;
    const anchorBottom = anchorRect.top + anchorRect.height + line * 0.9;
    let captionIndex = bands.findIndex((band) => band.bottom >= anchorTop && band.top <= anchorBottom);
    if (captionIndex < 0) {
      const anchorCenter = anchorRect.top + anchorRect.height / 2;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < bands.length; index += 1) {
        const bandCenter = (bands[index].top + bands[index].bottom) / 2;
        const distance = Math.abs(bandCenter - anchorCenter);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          captionIndex = index;
        }
      }
      if (nearestDistance > line * 2.5) {
        continue;
      }
    }

    let top = bands[captionIndex].top;
    let bottomBand = bands[captionIndex].bottom;

    for (let index = captionIndex - 1; index >= 0; index -= 1) {
      const gap = top - bands[index].bottom;
      if (gap > (direction === "above" ? clusterGap : line * 1.8)) {
        break;
      }
      top = bands[index].top;
    }
    for (let index = captionIndex + 1; index < bands.length; index += 1) {
      const gap = bands[index].top - bottomBand;
      if (gap > (direction === "below" ? clusterGap : line * 1.8)) {
        break;
      }
      bottomBand = bands[index].bottom;
    }

    const hasObject =
      direction === "above"
        ? top < anchorRect.top - line * 2
        : bottomBand > anchorRect.top + anchorRect.height + line * 2;
    if (!hasObject) {
      continue;
    }

    const bounds = inkBoundsInRect(image, { x: 0, y: top, width: viewportWidth, height: bottomBand - top + 1 });
    if (bounds && bounds.height > line * 3.2) {
      return padCropRect(bounds, 28, 22, viewportWidth, viewportHeight);
    }
  }
  return textBlockVisualCropRect(image, anchorRect, kind, viewportWidth, viewportHeight);
}

function visualCropRectForRegionPreview(
  image: ImageData,
  boxes: TextLayerBox[],
  range: { start: number; end: number },
  kind: ReferencePreviewKind,
  viewportWidth: number,
  viewportHeight: number,
) {
  const anchorRect = rectForTextRange(boxes, range.start, range.end);
  if (!anchorRect) {
    return null;
  }
  const textRect = cropRectForRegionPreview(boxes, range, kind, viewportWidth, viewportHeight);
  const visualRect =
    kind === "equation"
      ? equationVisualCropRect(image, anchorRect, viewportWidth, viewportHeight)
      : kind === "figure" || kind === "table" || kind === "algorithm"
        ? captionObjectVisualCropRect(image, anchorRect, kind, viewportWidth, viewportHeight)
        : textBlockVisualCropRect(image, anchorRect, kind, viewportWidth, viewportHeight);
  return visualRect ?? textRect;
}

export async function renderPdfPageRegionDataUrl(
  pdf: PreviewPdfDocument,
  pageNumber: number,
  target: PdfLinkPreviewTarget,
  scale = 1.85,
) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is not available.");
  }
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const renderTask = page.render({ canvasContext: context, viewport });
  const content = await page.getTextContent();
  const { text, boxes } = textBoxesFromPdfItems(content.items, viewport, scale);
  await renderTask.promise;
  const range = targetRangeForRegionPreview(text, target);
  const pageImage = context.getImageData(0, 0, canvas.width, canvas.height);
  const rect = range
    ? visualCropRectForRegionPreview(pageImage, boxes, range, target.previewKind, viewport.width, viewport.height)
    : null;
  if (!rect) {
    return null;
  }
  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = Math.max(1, Math.ceil(rect.width));
  cropCanvas.height = Math.max(1, Math.ceil(rect.height));
  const cropContext = cropCanvas.getContext("2d");
  if (!cropContext) {
    throw new Error("Canvas is not available.");
  }
  cropContext.fillStyle = "#ffffff";
  cropContext.fillRect(0, 0, cropCanvas.width, cropCanvas.height);
  cropContext.drawImage(
    canvas,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    cropCanvas.width,
    cropCanvas.height,
  );
  return cropCanvas.toDataURL("image/png");
}

export function hostFromUrl(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return rawUrl.replace(/^https?:\/\//i, "").split(/[/?#]/)[0] || rawUrl;
  }
}

export function externalPreviewSummary(url: string, ui: UiStrings = uiStrings.ko) {
  const host = hostFromUrl(url);
  const path = (() => {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`.replace(/^\/$/, "");
    } catch {
      return "";
    }
  })();
  return [
    `${host} ${ui.externalPreviewConnectsTo}`,
    path ? `${ui.externalPreviewPath}: ${path}` : "",
    ui.externalPreviewDescription,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function resolvePdfDestinationPage(pdf: PreviewPdfDocument, dest: unknown) {
  let resolved = dest;
  if (typeof resolved === "string" && pdf.getDestination) {
    resolved = await pdf.getDestination(resolved);
  }
  if (!Array.isArray(resolved) || resolved.length === 0) {
    return null;
  }
  const pageRef = resolved[0];
  if (typeof pageRef === "number") {
    return clampNumber(Math.floor(pageRef) + 1, 1, pdf.numPages);
  }
  if (pageRef && pdf.getPageIndex) {
    const pageIndex = await pdf.getPageIndex(pageRef);
    return clampNumber(pageIndex + 1, 1, pdf.numPages);
  }
  return null;
}

export async function flattenPdfOutlineRows(pdf: PreviewPdfDocument, items: PdfOutlineItem[], pageCount: number) {
  const rows: OutlineRow[] = [];
  const visit = async (entries: PdfOutlineItem[], depth: number, fallbackPage: number) => {
    let cursorPage = fallbackPage;
    for (const entry of entries) {
      const title = cleanOutlineTitle(entry.title ?? "", "");
      const resolvedPage = entry.dest ? await resolvePdfDestinationPage(pdf, entry.dest).catch(() => null) : null;
      const page = resolvedPage ?? cursorPage;
      if (title) {
        rows.push({
          id: `pdf-outline-${rows.length}-${page}-${outlineDomToken(title).slice(0, 36)}`,
          page: clampNumber(page, 1, Math.max(1, pageCount || pdf.numPages)),
          title,
          level: clampNumber(depth, 0, 3),
          source: "pdf",
        });
      }
      cursorPage = resolvedPage ?? cursorPage;
      if (entry.items?.length) {
        await visit(entry.items, depth + 1, cursorPage);
      }
      if (rows.length >= 60) {
        break;
      }
    }
  };
  await visit(items, 0, 1);
  return rows;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snippetAround(text: string, index: number, limit = 220) {
  const source = normalizeComparable(text);
  if (!source) {
    return "";
  }
  const start = clampNumber(index - Math.floor(limit / 2), 0, Math.max(0, source.length - 1));
  const end = clampNumber(start + limit, 0, source.length);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < source.length ? "..." : "";
  return `${prefix}${source.slice(start, end).trim()}${suffix}`;
}

function referenceSectionStartPage(pages: PageRecord[]) {
  return (
    pages.find((page) => /\b(references|bibliography|works cited|literature cited)\b/i.test(page.text))?.pageNumber ??
    null
  );
}

type ReferenceTargetPattern = {
  regex: RegExp;
  score: number;
  preferReferences?: boolean;
  preferMath?: boolean;
};

function regexWithGlobal(pattern: RegExp) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

export function isRegionPreviewKind(kind: ReferencePreviewKind) {
  return ["citation", "equation", "figure", "table", "algorithm", "theorem", "definition", "remark"].includes(kind);
}

function findReferenceTargetByPatterns(
  pages: PageRecord[],
  sourcePage: number,
  patterns: ReferenceTargetPattern[],
) {
  const referenceStart = referenceSectionStartPage(pages);
  let best: { page: number; excerpt: string; score: number; targetText: string } | null = null;
  for (const page of pages) {
    const text = normalizeComparable(page.text);
    if (!text) {
      continue;
    }
    for (const pattern of patterns) {
      const regex = regexWithGlobal(pattern.regex);
      for (let match = regex.exec(text); match; match = regex.exec(text)) {
        const index = match.index ?? 0;
        const windowText = text.slice(Math.max(0, index - 100), Math.min(text.length, index + 140));
        let score = pattern.score;
        if (pattern.preferReferences && referenceStart !== null && page.pageNumber >= referenceStart) {
          score += 12;
        }
        if (pattern.preferMath && /[=+\-*/^_{}<>]|\\sum|\\int|\\prod|\\lim/i.test(windowText)) {
          score += 10;
        }
        if (/[.:]\s+[A-Z0-9]/.test(windowText.slice(Math.max(0, match[0].length - 3), match[0].length + 8))) {
          score += 2;
        }
        score += Math.max(0, 5 - Math.abs(page.pageNumber - sourcePage)) * 0.15;
        if (page.pageNumber === sourcePage && pages.length > 1) {
          score -= 0.75;
        }
        if (!best || score > best.score) {
          best = { page: page.pageNumber, excerpt: snippetAround(text, index), score, targetText: match[0] };
        }
        if (match[0].length === 0) {
          regex.lastIndex += 1;
        }
      }
    }
  }
  return best;
}

function citationNumberTarget(pages: PageRecord[], sourcePage: number, marker: string) {
  const number = marker.match(/\d+/)?.[0];
  if (!number) {
    return null;
  }
  const escaped = escapeRegExp(number);
  return findReferenceTargetByPatterns(pages, sourcePage, [
    { regex: new RegExp(`\\[\\s*${escaped}\\s*\\]`, "i"), score: 8, preferReferences: true },
    { regex: new RegExp(`(?:^|\\s)${escaped}\\s*[.)]\\s+[A-Z]`, "i"), score: 4, preferReferences: true },
  ]);
}

function authorYearTarget(pages: PageRecord[], sourcePage: number, surname: string, year: string) {
  const cleanSurname = surname.replace(/[^A-Za-z'-]/g, "");
  const cleanYear = year.match(/\d{4}/)?.[0] ?? "";
  if (cleanSurname.length < 2 || !cleanYear) {
    return null;
  }
  return findReferenceTargetByPatterns(pages, sourcePage, [
    {
      regex: new RegExp(`${escapeRegExp(cleanSurname)}.{0,180}${escapeRegExp(cleanYear)}`, "i"),
      score: 7,
      preferReferences: true,
    },
    {
      regex: new RegExp(`${escapeRegExp(cleanYear)}.{0,180}${escapeRegExp(cleanSurname)}`, "i"),
      score: 4,
      preferReferences: true,
    },
  ]);
}

function firstStatementTarget(
  pages: PageRecord[],
  kind: ReferencePreviewKind,
  labelNumber: string,
  preferredLabel = "",
) {
  if (!isStatementPreviewKind(kind)) {
    return null;
  }
  const orderedPages = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  for (const page of orderedPages) {
    const text = normalizeComparable(page.text);
    const range = firstStatementLabelRange(text, kind, labelNumber, preferredLabel);
    if (!range) {
      continue;
    }
    const targetText = text.slice(range.start, range.end).trim();
    return {
      page: page.pageNumber,
      excerpt: snippetAround(text, range.start),
      score: 30,
      targetText,
    };
  }
  return null;
}

function labeledReferenceTarget(
  pages: PageRecord[],
  sourcePage: number,
  kind: ReferencePreviewKind,
  labelNumber: string,
  preferredLabel = "",
) {
  const escaped = escapeRegExp(labelNumber);
  if (kind === "page") {
    const page = Number(labelNumber);
    return page >= 1 && page <= pages.length
      ? {
          page,
          excerpt: pages.find((item) => item.pageNumber === page)?.outlineLabel || `Page ${page}`,
          score: 20,
          targetText: `Page ${page}`,
        }
      : null;
  }
  if (kind === "equation") {
    return findReferenceTargetByPatterns(pages, sourcePage, [
      { regex: new RegExp(`\\(\\s*${escaped}\\s*\\)`, "i"), score: 6, preferMath: true },
      { regex: new RegExp(`(?:eq\\.?|equation)\\s*\\(?\\s*${escaped}\\s*\\)?`, "i"), score: 4, preferMath: true },
    ]);
  }
  if (kind === "section") {
    return findReferenceTargetByPatterns(pages, sourcePage, [
      { regex: new RegExp(`(?:^|\\s)${escaped}\\s+[A-Z][A-Za-z]`, "i"), score: 9 },
      { regex: new RegExp(`(?:sec\\.?|section|appendix)\\s*${escaped}`, "i"), score: 5 },
    ]);
  }
  const statementTarget = firstStatementTarget(pages, kind, labelNumber, preferredLabel);
  if (statementTarget) {
    return statementTarget;
  }
  const labels: Record<string, string[]> = {
    figure: ["fig\\.?", "figure"],
    table: ["table"],
    algorithm: ["alg\\.?", "algorithm"],
    theorem: ["theorem", "lemma", "proposition", "corollary"],
    definition: ["definition", "def\\.?"],
    remark: ["remark", "rem\\.?"],
    link: [],
    citation: [],
    equation: [],
    section: [],
    page: [],
  };
  const labelAlternatives = labels[kind] ?? [];
  if (labelAlternatives.length === 0) {
    return null;
  }
  const label = `(?:${labelAlternatives.join("|")})`;
  return findReferenceTargetByPatterns(pages, sourcePage, [
    { regex: new RegExp(`${label}\\s*${escaped}\\s*[:.(]`, "i"), score: 14 },
    { regex: new RegExp(`${label}\\s*${escaped}`, "i"), score: 5 },
  ]);
}

function rectForTextRange(boxes: TextLayerBox[], start: number, end: number) {
  const selected = boxes
    .filter((box) => box.end > start && box.start < end)
    .map((box) => {
      const length = Math.max(1, box.end - box.start);
      const startRatio = clampNumber((Math.max(start, box.start) - box.start) / length, 0, 1);
      const endRatio = clampNumber((Math.min(end, box.end) - box.start) / length, startRatio, 1);
      const left = box.rect.left + box.rect.width * startRatio;
      const width = Math.max(2, box.rect.width * (endRatio - startRatio));
      return {
        rect: {
          left,
          top: box.rect.top,
          width,
          height: box.rect.height,
        },
      };
    });
  if (selected.length === 0) {
    return null;
  }
  const left = Math.min(...selected.map((box) => box.rect.left));
  const top = Math.min(...selected.map((box) => box.rect.top));
  const right = Math.max(...selected.map((box) => box.rect.left + box.rect.width));
  const bottom = Math.max(...selected.map((box) => box.rect.top + box.rect.height));
  const width = right - left;
  const height = bottom - top;
  return width > 2 && height > 2 ? { left, top, width, height } : null;
}

export function referencePreviewTargetsForPage(
  sourcePage: number,
  text: string,
  boxes: TextLayerBox[],
  pages: PageRecord[],
) {
  if (!text || boxes.length === 0 || pages.length === 0) {
    return [];
  }
  const targets: PdfLinkPreviewTarget[] = [];
  const targetRanges: Array<{ start: number; end: number }> = [];
  const addTarget = (
    match: RegExpExecArray,
    kind: ReferencePreviewKind,
    title: string,
    target: { page: number; excerpt: string; targetText?: string } | null,
  ) => {
    if (!target) {
      return;
    }
    const start = match.index;
    const end = start + match[0].length;
    if (targetRanges.some((range) => Math.max(start, range.start) < Math.min(end, range.end))) {
      return;
    }
    const rect = rectForTextRange(boxes, start, end);
    if (!rect) {
      return;
    }
    targets.push({
      id: `${sourcePage}:${kind}:${targets.length}:${start}:${end}`,
      sourcePage,
      title,
      kind: "internal",
      previewKind: kind,
      rect,
      targetPage: target.page,
      targetText: target.targetText,
      excerpt: target.excerpt,
      referenceText: match[0],
    });
    targetRanges.push({ start, end });
  };

  const labelPatterns: Array<{
    regex: RegExp;
    kind: ReferencePreviewKind;
    title: (match: RegExpExecArray) => string;
    valueIndex?: number;
    labelIndex?: number;
  }> = [
    { regex: /\b(?:Eq\.?|Equation)\s*\(?\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)\s*\)?/gi, kind: "equation", title: (match) => `Equation (${match[1]})` },
    { regex: /\b(?:Fig\.?|Figure)\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/gi, kind: "figure", title: (match) => `Figure ${match[1]}` },
    { regex: /\bTable\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/gi, kind: "table", title: (match) => `Table ${match[1]}` },
    { regex: /\b(?:Alg\.?|Algorithm)\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/gi, kind: "algorithm", title: (match) => `Algorithm ${match[1]}` },
    {
      regex: /\b(Theorem|Lemma|Proposition|Corollary)\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/gi,
      kind: "theorem",
      title: (match) => `${match[1]} ${match[2]}`,
      valueIndex: 2,
      labelIndex: 1,
    },
    {
      regex: /\b(Def\.?|Definition)\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/gi,
      kind: "definition",
      title: (match) => `${/^def\.?$/i.test(match[1]) ? "Definition" : match[1]} ${match[2]}`,
      valueIndex: 2,
      labelIndex: 1,
    },
    {
      regex: /\b(Rem\.?|Remark)\s*([A-Za-z]?\d+(?:\.\d+)*[a-z]?)/gi,
      kind: "remark",
      title: (match) => `${/^rem\.?$/i.test(match[1]) ? "Remark" : match[1]} ${match[2]}`,
      valueIndex: 2,
      labelIndex: 1,
    },
    { regex: /\b(?:Sec\.?|Section|Appendix)\s*([A-Za-z]?\d+(?:\.\d+){0,3}[a-z]?)/gi, kind: "section", title: (match) => `Section ${match[1]}` },
    { regex: /\b(?:page|p\.)\s*(\d{1,4})\b/gi, kind: "page", title: (match) => `Page ${match[1]}` },
  ];

  for (const pattern of labelPatterns) {
    for (let match = pattern.regex.exec(text); match && targets.length < 48; match = pattern.regex.exec(text)) {
      const labelNumber = match[pattern.valueIndex ?? 1];
      addTarget(
        match,
        pattern.kind,
        pattern.title(match),
        labeledReferenceTarget(pages, sourcePage, pattern.kind, labelNumber, pattern.labelIndex ? match[pattern.labelIndex] : ""),
      );
    }
  }

  return targets;
}


export function isUnsafeGeneratedHref(rawHref: string | null | undefined) {
  const href = (rawHref ?? "").trim();
  const lower = href.toLowerCase();
  return (
    lower.startsWith("#type=click") ||
    lower.includes("#type=click&tag=") ||
    lower.includes("openai.codex_") ||
    lower.startsWith("app:") ||
    lower.startsWith("file:") ||
    /^[a-z]:[\\/]/i.test(href)
  );
}
