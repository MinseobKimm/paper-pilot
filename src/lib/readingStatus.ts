export type ReadingStatus = "mastered" | "understood" | "reading" | "queued" | "unread";

export const defaultReadingStatus: ReadingStatus = "unread";

export const readingStatusOptions: Array<{
  value: ReadingStatus;
  label: string;
  shortLabel: string;
  color: string;
  background: string;
}> = [
  {
    value: "mastered",
    label: "완벽 이해",
    shortLabel: "완벽",
    color: "#15803d",
    background: "#dcfce7",
  },
  {
    value: "understood",
    label: "얼추 이해",
    shortLabel: "이해",
    color: "#0f766e",
    background: "#ccfbf1",
  },
  {
    value: "reading",
    label: "읽는 중",
    shortLabel: "진행",
    color: "#2563eb",
    background: "#dbeafe",
  },
  {
    value: "queued",
    label: "읽을 예정",
    shortLabel: "예정",
    color: "#7c3aed",
    background: "#ede9fe",
  },
  {
    value: "unread",
    label: "아예 안 읽음",
    shortLabel: "미독",
    color: "#7a8288",
    background: "#ffffff",
  },
];

export function readingStatusSettingKey(documentId: string) {
  return `readingStatus:${documentId}`;
}

export function normalizeReadingStatus(value: string | undefined): ReadingStatus {
  return readingStatusOptions.some((option) => option.value === value) ? (value as ReadingStatus) : defaultReadingStatus;
}

export function readingStatusFromSettings(settings: Record<string, string>, documentId: string): ReadingStatus {
  return normalizeReadingStatus(settings[readingStatusSettingKey(documentId)]);
}

export function readingStatusOption(value: string | undefined) {
  return readingStatusOptions.find((option) => option.value === normalizeReadingStatus(value)) ?? readingStatusOptions[readingStatusOptions.length - 1];
}
