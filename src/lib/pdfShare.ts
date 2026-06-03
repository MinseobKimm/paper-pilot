import type { AiResultRecord, PageRecord } from "../types";
import { translationEntriesForShare } from "./translations";
import { uiStrings, type UiStrings } from "./uiStrings";

type SharePdfPageProxy = {
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> };
};

export type SharePdfDocument = {
  getPage(pageNumber: number): Promise<SharePdfPageProxy>;
};

export type SharePdfPage = {
  jpegBytes: Uint8Array;
  imageWidth: number;
  imageHeight: number;
  pageWidth: number;
  pageHeight: number;
};

function bytesFromDataUrl(dataUrl: string) {
  const base64 = dataUrl.split(",")[1] ?? "";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function loadImageDataUrl(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load rendered PDF page image."));
    image.src = dataUrl;
  });
}

function wrapCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  const tokens = text.replace(/\s+/g, " ").trim().split(/(\s+)/).filter(Boolean);
  let line = "";
  function pushLongToken(token: string) {
    for (const char of Array.from(token)) {
      const candidate = line ? `${line}${char}` : char;
      if (context.measureText(candidate).width > maxWidth && line) {
        lines.push(line.trimEnd());
        line = char;
      } else {
        line = candidate;
      }
    }
  }
  for (const token of tokens.length ? tokens : [text]) {
    if (context.measureText(token).width > maxWidth) {
      pushLongToken(token);
      continue;
    }
    const candidate = line ? `${line}${token}` : token;
    if (context.measureText(candidate).width > maxWidth && line.trim()) {
      lines.push(line.trimEnd());
      line = token.trimStart();
    } else {
      line = candidate;
    }
  }
  if (line.trim()) {
    lines.push(line.trimEnd());
  }
  return lines.length ? lines : [""];
}

function measureShareRows(
  context: CanvasRenderingContext2D,
  entries: Array<{ label: string; text: string }>,
  contentWidth: number,
  fontSize: number,
) {
  const labelWidth = 34;
  const lineHeight = Math.max(8, Math.round(fontSize * 1.35));
  const rowGap = fontSize <= 8 ? 2 : fontSize <= 10 ? 4 : 8;
  context.font = `${fontSize}px "Segoe UI", "Malgun Gothic", Arial, sans-serif`;
  const rows = entries.map((entry) => {
    const lines = wrapCanvasText(context, entry.text, contentWidth - labelWidth);
    return {
      ...entry,
      lines,
      height: Math.max(lineHeight, lines.length * lineHeight) + rowGap,
    };
  });
  return {
    rows,
    lineHeight,
    totalHeight: rows.reduce((sum, row) => sum + row.height, 0),
  };
}

function fitShareRows(
  context: CanvasRenderingContext2D,
  entries: Array<{ label: string; text: string }>,
  contentWidth: number,
  contentHeight: number,
) {
  let best = measureShareRows(context, entries, contentWidth, 7);
  for (let fontSize = 16; fontSize >= 7; fontSize -= 1) {
    const measured = measureShareRows(context, entries, contentWidth, fontSize);
    best = measured;
    if (measured.totalHeight <= contentHeight) {
      return { ...measured, fontSize, fits: true };
    }
  }
  return { ...best, fontSize: 7, fits: false };
}

export async function renderPdfPageDataUrl(pdf: SharePdfDocument, pageNumber: number, scale = 1.45) {
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
  await renderTask.promise;
  return canvas.toDataURL("image/png");
}


export async function createTranslatedSharePage(
  pageImageDataUrl: string,
  page: PageRecord,
  aiResults: AiResultRecord[],
  targetLanguage?: string,
  ui: UiStrings = uiStrings.ko,
): Promise<SharePdfPage> {
  const pageImage = await loadImageDataUrl(pageImageDataUrl);
  const entries = translationEntriesForShare(page, aiResults, targetLanguage, ui);
  const probeCanvas = document.createElement("canvas");
  const probeContext = probeCanvas.getContext("2d");
  if (!probeContext) {
    throw new Error("Canvas is not available.");
  }

  const sideWidthCandidates = [
    Math.max(960, Math.round(pageImage.width * 1.35)),
    Math.max(1280, Math.round(pageImage.width * 1.75)),
    Math.max(1700, Math.round(pageImage.width * 2.25)),
    Math.max(2200, Math.round(pageImage.width * 3)),
  ];
  let sideWidth = sideWidthCandidates[0];
  let margin = Math.max(28, Math.round(sideWidth * 0.045));
  let contentWidth = sideWidth - margin * 2;
  let contentTop = margin + 52;
  let fitted = fitShareRows(probeContext, entries, contentWidth, pageImage.height - contentTop - margin);
  for (const candidate of sideWidthCandidates) {
    const candidateMargin = Math.max(28, Math.round(candidate * 0.045));
    const candidateContentWidth = candidate - candidateMargin * 2;
    const candidateContentTop = candidateMargin + 52;
    const candidateFitted = fitShareRows(
      probeContext,
      entries,
      candidateContentWidth,
      pageImage.height - candidateContentTop - candidateMargin,
    );
    sideWidth = candidate;
    margin = candidateMargin;
    contentWidth = candidateContentWidth;
    contentTop = candidateContentTop;
    fitted = candidateFitted;
    if (candidateFitted.fits) {
      break;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = pageImage.width + sideWidth;
  canvas.height = pageImage.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is not available.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(pageImage, 0, 0);

  const sidebarX = pageImage.width;
  context.fillStyle = "#fbfcfb";
  context.fillRect(sidebarX, 0, sideWidth, canvas.height);
  context.strokeStyle = "#d7e0dd";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(sidebarX + 1, 0);
  context.lineTo(sidebarX + 1, canvas.height);
  context.stroke();

  const titleTop = margin;
  context.fillStyle = "#202427";
  context.font = `700 ${Math.max(22, Math.round(canvas.height / 46))}px "Segoe UI", "Malgun Gothic", Arial, sans-serif`;
  context.fillText(`${ui.page} ${page.pageNumber} ${ui.translationPanel}`, sidebarX + margin, titleTop + 4);
  const labelWidth = 34;
  let y = contentTop;
  context.font = `${fitted.fontSize}px "Segoe UI", "Malgun Gothic", Arial, sans-serif`;
  for (const row of fitted.rows) {
    if (y > canvas.height - margin) {
      break;
    }
    context.fillStyle = "#8b8f8d";
    context.font = `700 ${fitted.fontSize}px "Segoe UI", "Malgun Gothic", Arial, sans-serif`;
    context.fillText(row.label, sidebarX + margin, y + fitted.lineHeight);
    context.fillStyle = "#202427";
    context.font = `${fitted.fontSize}px "Segoe UI", "Malgun Gothic", Arial, sans-serif`;
    row.lines.forEach((line, index) => {
      context.fillText(line, sidebarX + margin + labelWidth, y + fitted.lineHeight * (index + 1));
    });
    y += row.height;
  }
  if (!fitted.fits) {
    context.fillStyle = "#c65f4a";
    context.font = `700 ${Math.max(10, fitted.fontSize)}px "Segoe UI", "Malgun Gothic", Arial, sans-serif`;
    context.fillText(ui.shareTruncated, sidebarX + margin, canvas.height - margin / 2);
  }

  const jpegDataUrl = canvas.toDataURL("image/jpeg", 0.92);
  return {
    jpegBytes: bytesFromDataUrl(jpegDataUrl),
    imageWidth: canvas.width,
    imageHeight: canvas.height,
    pageWidth: Math.round(canvas.width * 0.75 * 100) / 100,
    pageHeight: Math.round(canvas.height * 0.75 * 100) / 100,
  };
}

function concatBytes(parts: Uint8Array[]) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function buildPdfFromJpegPages(pages: SharePdfPage[]) {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [0];
  let byteLength = 0;
  let objectNumber = 1;
  const add = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    byteLength += bytes.length;
  };
  const addObject = (parts: Array<string | Uint8Array>) => {
    const number = objectNumber;
    objectNumber += 1;
    offsets[number] = byteLength;
    add(`${number} 0 obj\n`);
    parts.forEach(add);
    add("\nendobj\n");
    return number;
  };

  add("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");
  const pageObjectNumbers = pages.map((_, index) => 3 + index * 3);
  addObject(["<< /Type /Catalog /Pages 2 0 R >>"]);
  addObject([`<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pages.length} >>`]);
  pages.forEach((page, index) => {
    const pageObject = 3 + index * 3;
    const imageObject = pageObject + 1;
    const contentObject = pageObject + 2;
    const imageName = `/Im${index + 1}`;
    const content = `q\n${page.pageWidth} 0 0 ${page.pageHeight} 0 0 cm\n${imageName} Do\nQ\n`;
    addObject([
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.pageWidth} ${page.pageHeight}] /Resources << /XObject << ${imageName} ${imageObject} 0 R >> >> /Contents ${contentObject} 0 R >>`,
    ]);
    addObject([
      `<< /Type /XObject /Subtype /Image /Width ${page.imageWidth} /Height ${page.imageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpegBytes.length} >>\nstream\n`,
      page.jpegBytes,
      "\nendstream",
    ]);
    addObject([`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`]);
  });
  const xrefOffset = byteLength;
  add(`xref\n0 ${objectNumber}\n0000000000 65535 f \n`);
  for (let index = 1; index < objectNumber; index += 1) {
    add(`${String(offsets[index] ?? 0).padStart(10, "0")} 00000 n \n`);
  }
  add(`trailer\n<< /Size ${objectNumber} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return concatBytes(chunks);
}
