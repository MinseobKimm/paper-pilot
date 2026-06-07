const exactDocumentSettingPrefixes = [
  "documentZoom:",
  "documentScrollLeft:",
  "readerBookmarks:",
  "readerLastViewport:",
  "pageTextLayoutAiVersion:",
  "documentOutlineVersion:",
  "readingStatus:",
  "documentWordList:",
];

const pagedDocumentSettingPrefixes = [
  "pageTextLayout:",
  "pageTextLayoutConfidence:",
  "pageTextLayoutSource:",
];

const wordMeaningMapSettingKey = "wordMeaningMapJson";

export function isDocumentScopedSettingKey(key: string, documentId: string) {
  if (!documentId) {
    return false;
  }
  if (exactDocumentSettingPrefixes.some((prefix) => key === `${prefix}${documentId}`)) {
    return true;
  }
  return pagedDocumentSettingPrefixes.some((prefix) => key.startsWith(`${prefix}${documentId}:`));
}

function pruneDocumentWordMeaningEntries(settings: Record<string, string>, documentIds: Set<string>) {
  const raw = settings[wordMeaningMapSettingKey];
  if (!raw || documentIds.size === 0) {
    return;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const map = parsed as Record<string, unknown>;
    let changed = false;
    for (const key of Object.keys(map)) {
      const entries = map[key];
      if (!Array.isArray(entries)) {
        continue;
      }
      const nextEntries = entries.filter((entry) => {
        if (!entry || typeof entry !== "object") {
          return true;
        }
        const documentId = (entry as Record<string, unknown>).documentId;
        return typeof documentId !== "string" || !documentIds.has(documentId);
      });
      if (nextEntries.length !== entries.length) {
        changed = true;
        if (nextEntries.length > 0) {
          map[key] = nextEntries;
        } else {
          delete map[key];
        }
      }
    }
    if (changed) {
      settings[wordMeaningMapSettingKey] = JSON.stringify(map);
    }
  } catch {
    // Leave malformed user data untouched.
  }
}

export function deleteDocumentScopedSettings(settings: Record<string, string>, documentIds: Iterable<string>) {
  const idSet = new Set(Array.from(documentIds).filter(Boolean));
  if (idSet.size === 0) {
    return;
  }
  pruneDocumentWordMeaningEntries(settings, idSet);
  for (const key of Object.keys(settings)) {
    if (Array.from(idSet).some((documentId) => isDocumentScopedSettingKey(key, documentId))) {
      delete settings[key];
    }
  }
}
