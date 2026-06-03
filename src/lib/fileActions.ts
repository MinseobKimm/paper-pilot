export function downloadText(fileName: string, text: string, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function downloadBytes(fileName: string, bytes: Uint8Array, type: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function canvasToCompressedImageDataUrl(source: HTMLCanvasElement, maxSide = 1400) {
  const scale = Math.min(1, maxSide / Math.max(1, source.width, source.height));
  const target = document.createElement("canvas");
  target.width = Math.max(1, Math.round(source.width * scale));
  target.height = Math.max(1, Math.round(source.height * scale));
  const context = target.getContext("2d");
  if (!context) {
    return source.toDataURL("image/png");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, target.width, target.height);
  context.drawImage(source, 0, 0, target.width, target.height);
  return target.toDataURL("image/jpeg", 0.84);
}

type BrowserFileHandle = {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

export async function saveBytesWithBrowserPicker(fileName: string, bytes: Uint8Array, type: string) {
  const picker = (window as Window & {
    showSaveFilePicker?: (options: {
      suggestedName: string;
      types: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<BrowserFileHandle>;
  }).showSaveFilePicker;
  if (!picker) {
    return "unsupported" as const;
  }
  try {
    const handle = await picker({
      suggestedName: fileName,
      types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(new Blob([new Uint8Array(bytes)], { type }));
    await writable.close();
    return "saved" as const;
  } catch (error) {
    if ((error as DOMException).name === "AbortError") {
      return "cancelled" as const;
    }
    throw error;
  }
}

export function safeFileName(value: string, fallback = "paper-pilot-share") {
  const safe = (value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
  return safe || fallback;
}

export function cleanSelection(text: string) {
  return text
    .replace(/([A-Za-z])-\s+([A-Za-z])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

export function compactUiText(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 3).trim()}...` : normalized;
}
