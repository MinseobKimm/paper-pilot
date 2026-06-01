import type { AnnotationRecord, PageRecord } from "../types";
import { makeId, nowIso } from "./ids";

export const highlightColors = [
  { name: "Teal", value: "#4ecdc4", key: "1" },
  { name: "Lime", value: "#b8e986", key: "2" },
  { name: "Coral", value: "#ff7f6e", key: "3" },
  { name: "Gold", value: "#f6c85f", key: "4" },
  { name: "Sky", value: "#7fb3ff", key: "5" },
];

const autoRules = [
  { tag: "Novelty", color: "#4ecdc4", pattern: /\b(novel|new|first|propose|introduce|contribution)\b/i },
  { tag: "Methods", color: "#b8e986", pattern: /\b(method|model|dataset|experiment|approach|algorithm)\b/i },
  { tag: "Results", color: "#ff7f6e", pattern: /\b(result|outperform|improve|accuracy|significant|evaluation)\b/i },
];

export function createAutoHighlights(documentId: string, pages: PageRecord[]): AnnotationRecord[] {
  const annotations: AnnotationRecord[] = [];
  for (const page of pages) {
    const sentences = page.text.match(/[^.!?]+[.!?]+/g) ?? [];
    for (const rule of autoRules) {
      const sentence = sentences.find((item) => rule.pattern.test(item));
      if (sentence && !annotations.some((item) => item.tag === rule.tag)) {
        annotations.push({
          id: makeId("auto"),
          documentId,
          page: page.pageNumber,
          kind: "auto",
          color: rule.color,
          text: sentence.trim(),
          rangeHint: sentence.trim().slice(0, 120),
          rects: [],
          comment: `${rule.tag} candidate`,
          tag: rule.tag,
          createdAt: nowIso(),
        });
      }
    }
  }
  return annotations;
}
