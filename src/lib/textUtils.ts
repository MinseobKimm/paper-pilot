export function cleanAiOutput(value: string, status = "") {
  const text = value
    .replace(/^\s*Token estimate:[^\n]*(?:\r?\n\r?\n)?/i, "")
    .replace(/(?:[A-Za-z]+ bridge task|Agent task):[^\n]+/gi, "")
    .replace(/Status: local draft is ready[^\n]*/gi, "")
    .replace(/Status: waiting for[^\n]*/gi, "")
    .replace(/(?:Bridge|Agent) worker not started automatically:[\s\S]*/gi, "")
    .trim();
  if (status === "pending") {
    return text
      .split("\n")
      .filter((line) => !line.toLowerCase().includes("queued") && !line.toLowerCase().includes("agent"))
      .join("\n")
      .trim();
  }
  return text;
}

export function stripJsonFence(value: string) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

export function parseAiJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const repaired = value
      .replace(/\\u(?![0-9a-fA-F]{4})/g, "\\\\u")
      .replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
    if (repaired !== value) {
      return JSON.parse(repaired) as unknown;
    }
    throw error;
  }
}

export function normalizeComparable(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeForMatch(value: string) {
  return normalizeComparable(value).toLowerCase();
}
