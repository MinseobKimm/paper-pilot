import katex from "katex";
import "katex/dist/katex.min.css";
import type { ReactNode } from "react";

function renderKatex(value: string, displayMode = false): string {
  try {
    return katex.renderToString(value.trim(), {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml",
      macros: {
        "\\RR": "\\mathbb{R}",
        "\\E": "\\mathbb{E}",
        "\\bm": "\\boldsymbol{#1}",
      },
    });
  } catch {
    return escapeHtml(value);
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function MathChunk(props: { value: string; display?: boolean }) {
  const html = renderKatex(normalizeDisplayMathValue(props.value), props.display);
  if (props.display) {
    return <div className="math-block" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <span className="math-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

function normalizeMathDelimiters(value: string) {
  return value
    .replace(/\\\\([()[\]])/g, "\\$1")
    .replace(/\\\\([A-Za-z]+)/g, "\\$1")
    .replace(/\\\\(begin|end)\{/g, "\\$1{");
}

function normalizeDisplayMathValue(value: string) {
  const text = normalizeMathDelimiters(value).trim();
  const env = text.match(/^\\begin\{([A-Za-z]+)\*?\}([\s\S]*)\\end\{\1\*?\}$/);
  if (!env) {
    return text;
  }
  const name = env[1];
  const body = env[2].trim();
  if (name === "equation") {
    return body;
  }
  if (name === "align" || name === "aligned" || name === "multline") {
    return `\\begin{aligned}${body}\\end{aligned}`;
  }
  if (name === "gather" || name === "gathered") {
    return `\\begin{gathered}${body}\\end{gathered}`;
  }
  return text;
}

function autoDelimitOutlineMathSegment(segment: string) {
  type Candidate = { start: number; end: number; value: string; priority: number };
  const candidates: Candidate[] = [];
  const addMatches = (pattern: RegExp, transform: (match: RegExpExecArray) => string, priority: number) => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(segment); match; match = pattern.exec(segment)) {
      const raw = match[0];
      const start = match.index ?? 0;
      const end = start + raw.length;
      if (!raw.trim() || segment[start - 1] === "$" || segment[end] === "$") {
        continue;
      }
      candidates.push({ start, end, value: transform(match).trim(), priority });
    }
  };

  addMatches(/\bR2\b(?=\s*(?:score|coefficient|regression|value|metric)\b)/gi, () => "R^2", 8);
  addMatches(
    /\b([A-Za-z])([0-9])(?=(?:[-\s]?(?:regulari[sz]ed|norm|loss|penalty|objective|distance|metric|constraint|error|score|model|method))\b)/gi,
    (match) => `${match[1]}_${match[2]}`,
    7,
  );
  addMatches(/\\[A-Za-z]+(?:\s*[_^]\s*(?:\{[^}]+\}|[A-Za-z0-9]+))*/g, (match) => match[0], 6);
  addMatches(/\bO\([^)]{1,36}\)/g, (match) => match[0], 6);
  addMatches(
    /\b[A-Za-z][A-Za-z0-9]*(?:[_^](?:\{[^}]+\}|[A-Za-z0-9]+))+(?:\s*(?:[+\-*/=]|<=|>=|=>)\s*[A-Za-z0-9\\_{}^]+)*/g,
    (match) => match[0],
    5,
  );
  addMatches(/[\u0391-\u03A9\u03B1-\u03C9](?:\s*[_^]\s*(?:\{[^}]+\}|[A-Za-z0-9]+))?/g, (match) => match[0], 4);
  addMatches(
    /\b[A-Za-z][A-Za-z0-9_{}^]*\s*(?:=|<=|>=|<|>)\s*[A-Za-z0-9\\_{}^+\-*/().\s]{1,36}/g,
    (match) => match[0].trim(),
    3,
  );

  if (candidates.length === 0) {
    return segment;
  }
  const selected: Candidate[] = [];
  for (const candidate of candidates.sort(
    (a, b) => a.start - b.start || b.priority - a.priority || b.end - b.start - (a.end - a.start),
  )) {
    if (!selected.some((item) => Math.max(item.start, candidate.start) < Math.min(item.end, candidate.end))) {
      selected.push(candidate);
    }
  }
  selected.sort((a, b) => a.start - b.start);
  let cursor = 0;
  let output = "";
  for (const candidate of selected) {
    output += segment.slice(cursor, candidate.start);
    output += `$${candidate.value}$`;
    cursor = candidate.end;
  }
  return output + segment.slice(cursor);
}

function outlineTextWithMathDelimiters(value: string) {
  const text = normalizeMathDelimiters(value);
  const pattern = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g;
  let cursor = 0;
  let output = "";
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      output += autoDelimitOutlineMathSegment(text.slice(cursor, index));
    }
    output += match[0];
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    output += autoDelimitOutlineMathSegment(text.slice(cursor));
  }
  return output;
}

export function OutlineTitleText(props: { text: string }) {
  return (
    <span className="outline-title-text">
      <InlineMathText text={outlineTextWithMathDelimiters(props.text)} inlineOnly />
    </span>
  );
}

export function InlinePageCitationText(props: { text: string; onPageCitation?: (page: number) => void }) {
  if (!props.onPageCitation) {
    return <>{props.text}</>;
  }
  const chunks: ReactNode[] = [];
  const pattern = /(\((?:p|page)\.?\s*(\d+)\)|\b(?:p|page)\.?\s*(\d+)\b)/gi;
  let cursor = 0;
  for (const match of props.text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const page = Number(match[2] ?? match[3]);
    if (index > cursor) {
      chunks.push(props.text.slice(cursor, index));
    }
    chunks.push(
      <button
        key={`${match[0]}-${index}`}
        type="button"
        className="page-citation-link"
        title="Go to page"
        onClick={() => props.onPageCitation?.(page)}
      >
        {`(p. ${page})`}
      </button>,
    );
    cursor = index + match[0].length;
  }
  if (cursor < props.text.length) {
    chunks.push(props.text.slice(cursor));
  }
  return <>{chunks}</>;
}

export function InlineMarkdownText(props: { text: string; onPageCitation?: (page: number) => void }) {
  const chunks: Array<{ value: string; strong: boolean }> = [];
  const pattern = /\*\*([^*]+(?:\*(?!\*)[^*]+)*)\*\*/g;
  let cursor = 0;
  for (const match of props.text.matchAll(pattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      chunks.push({ value: props.text.slice(cursor, index), strong: false });
    }
    chunks.push({ value: match[1], strong: true });
    cursor = index + raw.length;
  }
  if (cursor < props.text.length) {
    chunks.push({ value: props.text.slice(cursor), strong: false });
  }
  if (chunks.length === 0) {
    return <>{props.text}</>;
  }
  return (
    <>
      {chunks.map((chunk, index) =>
        chunk.strong ? (
          <strong key={`${chunk.value}-${index}`}>
            <InlinePageCitationText text={chunk.value} onPageCitation={props.onPageCitation} />
          </strong>
        ) : (
          <span key={`${chunk.value}-${index}`}>
            <InlinePageCitationText text={chunk.value} onPageCitation={props.onPageCitation} />
          </span>
        ),
      )}
    </>
  );
}

export function InlineMathText(props: { text: string; inlineOnly?: boolean; onPageCitation?: (page: number) => void }) {
  const chunks: Array<{ value: string; math: boolean; display?: boolean }> = [];
  const text = normalizeMathDelimiters(props.text);
  const pattern = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+?\$)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    const index = match.index ?? 0;
    if (index > cursor) {
      chunks.push({ value: text.slice(cursor, index), math: false });
    }
    if (raw.startsWith("$$") && raw.endsWith("$$")) {
      chunks.push({ value: raw.slice(2, -2), math: true, display: !props.inlineOnly });
    } else if (raw.startsWith("\\[") && raw.endsWith("\\]")) {
      chunks.push({ value: raw.slice(2, -2), math: true, display: !props.inlineOnly });
    } else if (raw.startsWith("\\(") && raw.endsWith("\\)")) {
      chunks.push({ value: raw.slice(2, -2), math: true });
    } else {
      chunks.push({ value: raw.slice(1, -1), math: true });
    }
    cursor = index + raw.length;
  }
  if (cursor < text.length) {
    chunks.push({ value: text.slice(cursor), math: false });
  }
  if (!chunks.some((chunk) => chunk.math)) {
    return <InlineMarkdownText text={text} onPageCitation={props.onPageCitation} />;
  }
  return (
    <>
      {chunks.map((chunk, index) =>
        chunk.math ? (
          <MathChunk key={`${chunk.value}-${index}`} value={chunk.value} display={chunk.display} />
        ) : (
          <span key={`${chunk.value}-${index}`}>
            <InlineMarkdownText text={chunk.value} onPageCitation={props.onPageCitation} />
          </span>
        ),
      )}
    </>
  );
}

type FormattedAiBlock =
  | { kind: "math"; value: string }
  | { kind: "text"; value: string };

function readDelimitedMathBlock(lines: string[], startIndex: number, startToken: string, endToken: string) {
  const firstLine = normalizeMathDelimiters(lines[startIndex].trim());
  const firstBody = firstLine.slice(startToken.length);
  const sameLineEnd = firstBody.indexOf(endToken);
  if (sameLineEnd >= 0) {
    return { value: firstBody.slice(0, sameLineEnd), nextIndex: startIndex + 1 };
  }
  const parts = [firstBody];
  let index = startIndex + 1;
  while (index < lines.length) {
    const line = normalizeMathDelimiters(lines[index]);
    const endIndex = line.indexOf(endToken);
    if (endIndex >= 0) {
      parts.push(line.slice(0, endIndex));
      return { value: parts.join("\n"), nextIndex: index + 1 };
    }
    parts.push(line);
    index += 1;
  }
  return { value: firstLine, nextIndex: startIndex + 1, unclosed: true };
}

function readEnvironmentMathBlock(lines: string[], startIndex: number) {
  const firstLine = normalizeMathDelimiters(lines[startIndex].trim());
  const start = firstLine.match(/^\\begin\{([A-Za-z]+)\*?\}/);
  if (!start) {
    return null;
  }
  const envName = start[1];
  const endPattern = new RegExp(`\\\\end\\{${envName}\\*?\\}`);
  const parts = [firstLine];
  if (endPattern.test(firstLine)) {
    return { value: firstLine, nextIndex: startIndex + 1 };
  }
  let index = startIndex + 1;
  while (index < lines.length) {
    const line = normalizeMathDelimiters(lines[index]);
    parts.push(line);
    if (endPattern.test(line)) {
      return { value: parts.join("\n"), nextIndex: index + 1 };
    }
    index += 1;
  }
  return { value: firstLine, nextIndex: startIndex + 1, unclosed: true };
}

function formattedAiBlocks(value: string): FormattedAiBlock[] {
  const lines = value.replace(/\r/g, "").split("\n");
  const blocks: FormattedAiBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = normalizeMathDelimiters(lines[index].trim());
    if (!line) {
      index += 1;
      continue;
    }
    if (line.startsWith("$$")) {
      const block = readDelimitedMathBlock(lines, index, "$$", "$$");
      blocks.push(block.unclosed ? { kind: "text", value: block.value } : { kind: "math", value: block.value });
      index = block.nextIndex;
      continue;
    }
    if (line.startsWith("\\[")) {
      const block = readDelimitedMathBlock(lines, index, "\\[", "\\]");
      blocks.push(block.unclosed ? { kind: "text", value: block.value } : { kind: "math", value: block.value });
      index = block.nextIndex;
      continue;
    }
    if (/^\\begin\{(?:equation|align|gather|multline|split|aligned|gathered)\*?\}/.test(line)) {
      const block = readEnvironmentMathBlock(lines, index);
      if (block) {
        blocks.push(block.unclosed ? { kind: "text", value: block.value } : { kind: "math", value: block.value });
        index = block.nextIndex;
        continue;
      }
    }
    blocks.push({ kind: "text", value: line });
    index += 1;
  }
  return blocks;
}

function FormattedAiLine(props: { line: string; index: number; onPageCitation?: (page: number) => void }) {
  const normalizedLine = normalizeMathDelimiters(props.line);
  const displayMath =
    normalizedLine.match(/^\$\$([\s\S]+)\$\$$/) ??
    normalizedLine.match(/^\\\[([\s\S]+)\\\]$/) ??
    normalizedLine.match(/^\\begin\{(?:equation|align|gather|multline|split|aligned|gathered)\*?\}([\s\S]+)\\end\{(?:equation|align|gather|multline|split|aligned|gathered)\*?\}$/);
  if (displayMath) {
    return <MathChunk key={`${props.line}-${props.index}`} value={displayMath[1]} display />;
  }
  const heading = normalizedLine.match(/^#{1,4}\s+(.+)/) ?? normalizedLine.match(/^\*\*(.+)\*\*:?$/);
  if (heading) {
    return (
      <h4 key={`${props.line}-${props.index}`}>
        <InlineMathText text={heading[1]} inlineOnly onPageCitation={props.onPageCitation} />
      </h4>
    );
  }
  const numbered = normalizedLine.match(/^(\d+)[.)]\s+(.+)/);
  if (numbered) {
    return (
      <div key={`${props.line}-${props.index}`} className="numbered-line">
        <b>{numbered[1]}.</b>
        <span>
          <InlineMathText text={numbered[2]} inlineOnly onPageCitation={props.onPageCitation} />
        </span>
      </div>
    );
  }
  const bullet = normalizedLine.match(/^[-*]\s+(.+)/);
  if (bullet) {
    return (
      <div key={`${props.line}-${props.index}`} className="bullet-line">
        <i />
        <span>
          <InlineMathText text={bullet[1]} inlineOnly onPageCitation={props.onPageCitation} />
        </span>
      </div>
    );
  }
  return (
    <p key={`${props.line}-${props.index}`}>
      <InlineMathText text={normalizedLine} inlineOnly onPageCitation={props.onPageCitation} />
    </p>
  );
}

export function FormattedAiText(props: { text: string; compact?: boolean; onPageCitation?: (page: number) => void }) {
  const blocks = formattedAiBlocks(props.text);
  const lines: string[] = [];
  if (blocks.length === 0) {
    return null;
  }
  return (
    <div className={props.compact ? "formatted-ai compact" : "formatted-ai"}>
      {blocks.map((block, index) =>
        block.kind === "math" ? (
          <MathChunk key={`math-${index}-${block.value}`} value={block.value} display />
        ) : (
          <FormattedAiLine key={`text-${index}-${block.value}`} line={block.value} index={index} onPageCitation={props.onPageCitation} />
        ),
      )}
      {lines.map((line, index) => {
        const normalizedLine = normalizeMathDelimiters(line);
        const displayMath =
          normalizedLine.match(/^\$\$([\s\S]+)\$\$$/) ??
          normalizedLine.match(/^\\\[([\s\S]+)\\\]$/) ??
          normalizedLine.match(/^\\begin\{(?:equation|align|gather)\*?\}([\s\S]+)\\end\{(?:equation|align|gather)\*?\}$/);
        if (displayMath) {
          return <MathChunk key={`${line}-${index}`} value={displayMath[1]} display />;
        }
        const heading = normalizedLine.match(/^#{1,4}\s+(.+)/) ?? normalizedLine.match(/^\*\*(.+)\*\*:?$/);
        if (heading) {
          return (
            <h4 key={`${line}-${index}`}>
              <InlineMathText text={heading[1]} />
            </h4>
          );
        }
        const numbered = normalizedLine.match(/^(\d+)[.)]\s+(.+)/);
        if (numbered) {
          return (
            <div key={`${line}-${index}`} className="numbered-line">
              <b>{numbered[1]}.</b>
              <span>
                <InlineMathText text={numbered[2]} />
              </span>
            </div>
          );
        }
        const bullet = normalizedLine.match(/^[-*]\s+(.+)/);
        if (bullet) {
          return (
            <div key={`${line}-${index}`} className="bullet-line">
              <i />
              <span>
                <InlineMathText text={bullet[1]} />
              </span>
            </div>
          );
        }
        return (
          <p key={`${line}-${index}`}>
            <InlineMathText text={normalizedLine} />
          </p>
        );
      })}
    </div>
  );
}
