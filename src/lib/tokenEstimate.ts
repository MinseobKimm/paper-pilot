export type TokenEstimate = {
  inputTokens?: number;
  outputTokens?: number;
};

export function estimateTokens(text: string): number {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) {
    return 0;
  }
  const cjk = clean.match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g)?.length ?? 0;
  const nonCjk = clean.length - cjk;
  const wordish = clean.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g)?.length ?? 0;
  return Math.max(1, Math.ceil(cjk * 1.15 + nonCjk / 4 + wordish * 0.08));
}

export function tokenEstimateMarkdown(estimate: TokenEstimate): string {
  const parts = [];
  if (typeof estimate.inputTokens === "number") {
    parts.push(`input ~${estimate.inputTokens.toLocaleString()} tokens`);
  }
  if (typeof estimate.outputTokens === "number") {
    parts.push(`output ~${estimate.outputTokens.toLocaleString()} tokens`);
  }
  return parts.length ? `Token estimate: ${parts.join(" / ")}` : "";
}

export function prependTokenEstimate(text: string, estimate: TokenEstimate): string {
  const line = tokenEstimateMarkdown(estimate);
  if (!line) {
    return text;
  }
  const body = text.trim();
  if (body.startsWith("Token estimate:")) {
    return body.replace(/^Token estimate:[^\n]*(?:\n\n)?/, `${line}\n\n`);
  }
  return body ? `${line}\n\n${body}` : line;
}

export function parseTokenEstimate(text: string): TokenEstimate {
  const firstLine = text.trimStart().split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.startsWith("Token estimate:")) {
    return {};
  }
  const input = firstLine.match(/input ~([\d,]+) tokens/i)?.[1];
  const output = firstLine.match(/output ~([\d,]+) tokens/i)?.[1];
  return {
    inputTokens: input ? Number(input.replace(/,/g, "")) : undefined,
    outputTokens: output ? Number(output.replace(/,/g, "")) : undefined,
  };
}
