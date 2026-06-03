import type { AiResultRecord, PageRecord } from "../types";
import { translationUnitsForPage, type TranslationUnit } from "./translations";

export function currentTranslationUnitsForSelection(
  currentPage: PageRecord | undefined,
  aiResults: AiResultRecord[],
  translationLanguageName: string,
) {
  return translationUnitsForPage(currentPage, aiResults, translationLanguageName);
}

export function selectedSourceSentenceIds(units: TranslationUnit[], selectedSentenceId: string | null) {
  if (!selectedSentenceId) {
    return [];
  }
  const selectedUnit = units.find(
    (unit) => unit.id === selectedSentenceId || (unit.sourceIds ?? []).includes(selectedSentenceId),
  );
  return selectedUnit?.sourceIds?.length ? selectedUnit.sourceIds : [selectedSentenceId];
}
