import type { PdfOutlineItem } from "./linkPreviews";

export type PdfAnnotationRecord = {
  subtype?: string;
  annotationType?: number;
  rect?: number[];
  url?: string;
  unsafeUrl?: string;
  dest?: unknown;
  action?: string;
  title?: string;
  contents?: string;
};

export type PdfPageProxy = {
  getViewport(options: { scale: number }): { width: number; height: number; transform: number[]; convertToViewportRectangle?: (rect: number[]) => number[] };
  render(options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void>; cancel?: () => void };
  getTextContent(): Promise<{ items: Array<{ str?: string; transform?: number[]; fontName?: string; width?: number; height?: number }> }>;
  getAnnotations?(options?: { intent?: string }): Promise<PdfAnnotationRecord[]>;
};

export type PdfDocumentProxy = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
  getOutline(): Promise<PdfOutlineItem[] | null>;
  getMetadata(): Promise<{ info?: { Title?: string; Author?: string; CreationDate?: string } }>;
  getDestination?(dest: string): Promise<unknown[] | null>;
  getPageIndex?(ref: unknown): Promise<number>;
};
