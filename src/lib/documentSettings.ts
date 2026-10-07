const exactDocumentSettingPrefixes = [
  "paperChatExcludedResults:",
  "documentZoom:",
  "documentScrollLeft:",
  "readerBookmarks:",
  "readerLastViewport:",
  "pageTextLayoutAiVersion:",
  "pdfTextExtractionVersion:",
  "documentOutlineVersion:",
  "paperCitationIndex:",
  "readingStatus:",
  "documentWordList:",
  "documentAutoTranslate:",
  "documentWordMeaningLookup:",
];

const pagedDocumentSettingPrefixes = [
  "pageTextLayout:",
  "pageTextLayoutConfidence:",
  "pageTextLayoutSource:",
];

export function isDocumentScopedSettingKey(key: string, documentId: string) {
  if (!documentId) {
    return false;
  }
  if (exactDocumentSettingPrefixes.some((prefix) => key === `${prefix}${documentId}`)) {
    return true;
  }
  return pagedDocumentSettingPrefixes.some((prefix) => key.startsWith(`${prefix}${documentId}:`));
}

export function deleteDocumentScopedSettings(settings: Record<string, string>, documentIds: Iterable<string>) {
  const idSet = new Set(Array.from(documentIds).filter(Boolean));
  if (idSet.size === 0) {
    return;
  }
  for (const key of Object.keys(settings)) {
    if (Array.from(idSet).some((documentId) => isDocumentScopedSettingKey(key, documentId))) {
      delete settings[key];
    }
  }
}
