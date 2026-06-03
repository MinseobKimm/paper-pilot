import { cleanAiOutput, parseAiJson, stripJsonFence } from "./textUtils";

export type AutoHighlightCandidate = {
  page: number;
  text: string;
  tag: string;
  reason: string;
};

export function colorForHighlightTag(tag: string) {
  const normalized = tag.toLowerCase();
  if (/method|algorithm|model|experiment/.test(normalized)) {
    return "#b8e986";
  }
  if (/result|performance|evaluation|score/.test(normalized)) {
    return "#ff7f6e";
  }
  if (/limit|limitation|problem|error|failure/.test(normalized)) {
    return "#f6c85f";
  }
  return "#4ecdc4";
}


export function parseAutoHighlightCandidates(outputText: string, fallbackPage: number): AutoHighlightCandidate[] {
  const readable = stripJsonFence(cleanAiOutput(outputText));
  if (!readable) {
    return [];
  }
  try {
    const parsed = parseAiJson(readable);
    const rows = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { highlights?: unknown }).highlights)
        ? (parsed as { highlights: unknown[] }).highlights
        : [];
    return rows
      .map((row) => {
        if (typeof row !== "object" || row === null) {
          return null;
        }
        const record = row as Record<string, unknown>;
        const text = String(record.text ?? record.sentence ?? record.quote ?? "").trim();
        if (!text) {
          return null;
        }
        return {
          page: Number(record.page ?? fallbackPage) || fallbackPage,
          text,
          tag: String(record.tag ?? record.category ?? "AI").trim() || "AI",
          reason: String(record.reason ?? record.comment ?? "").trim(),
        };
      })
      .filter(Boolean) as AutoHighlightCandidate[];
  } catch {
    return readable
      .split(/\n+/)
      .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
      .filter((line) => line.length > 12)
      .slice(0, 6)
      .map((line) => ({
        page: fallbackPage,
        text: line.replace(/^["']|["']$/g, ""),
        tag: "AI",
        reason: "",
      }));
  }
}
