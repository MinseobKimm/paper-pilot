import type { AnnotationRecord } from "../types";
import { normalizeForMatch } from "./textUtils";

export const explanationTag = "Explanation";
export const explanationColor = "#d9e5ff";
export const explanationTasks = new Set(["explainText", "explainRegionImage"]);
export const annotationFilters = [
  { id: "text", labelKey: "text", color: "#8f8f98" },
  { id: "image", labelKey: "image", color: "#ff9d00" },
  { id: "url", labelKey: "url", color: "#4d9fff" },
  { id: "table", labelKey: "table", color: "#b86428" },
  { id: "formula", labelKey: "formula", color: "#ff4b66" },
];

export function annotationKey(annotation: AnnotationRecord) {
  return `${annotation.page}:${annotation.tag}:${normalizeForMatch(annotation.rangeHint || annotation.text).slice(0, 100)}`;
}

export function isExplanationAnnotation(annotation: AnnotationRecord) {
  return annotation.tag === explanationTag;
}

export function explanationResultId(annotation: AnnotationRecord) {
  return annotation.comment.startsWith("ai:") ? annotation.comment.slice(3) : "";
}

