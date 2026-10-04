import type { TextLine } from "./pdfText";

const right = (line: TextLine) => line.rect.left + line.rect.width;
const bottom = (line: TextLine) => line.rect.top + line.rect.height;
const centerY = (line: TextLine) => line.rect.top + line.rect.height / 2;
const visual = (a: TextLine, b: TextLine) => a.rect.top - b.rect.top || a.rect.left - b.rect.left;
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] || 1;

function columnSplit(lines: TextLine[], font: number) {
  const leftEdge = Math.min(...lines.map((line) => line.rect.left));
  const rightEdge = Math.max(...lines.map(right));
  const width = rightEdge - leftEdge;
  const edges = [...new Set(lines.flatMap((line) => [line.rect.left, right(line)]))].sort((a, b) => a - b);
  let best: { x: number; score: number; left: TextLine[]; right: TextLine[]; crossing: TextLine[] } | null = null;
  for (let index = 1; index < edges.length; index += 1) {
    const gap = edges[index] - edges[index - 1];
    const x = (edges[index] + edges[index - 1]) / 2;
    if (gap < font * 0.55 || x < leftEdge + width * 0.16 || x > rightEdge - width * 0.16) continue;
    const left = lines.filter((line) => right(line) < x);
    const rightLines = lines.filter((line) => line.rect.left > x);
    const crossing = lines.filter((line) => line.rect.left <= x && right(line) >= x);
    // Require sustained prose on both sides. Numeric table cells and isolated
    // labels are read row by row rather than mistaken for newspaper columns.
    const prose = (line: TextLine) => line.text.replace(/[^\p{L}]/gu, "").length >= 18 && line.rect.width >= font * 7;
    const leftBody = left.filter(prose);
    const rightBody = rightLines.filter(prose);
    if (leftBody.length < 3 || rightBody.length < 3) continue;
    const paired = leftBody.filter((line) => rightBody.some((other) => Math.abs(centerY(line) - centerY(other)) < font * 2)).length;
    if (paired < 3) continue;
    const score = Math.min(leftBody.length, rightBody.length) * 3 + paired - crossing.length * 2 + Math.min(gap / font, 4);
    if (score <= 0 || (best && best.score >= score)) continue;
    best = { x, score, left, right: rightLines, crossing };
  }
  return best;
}

/** Recursive whitespace partitioning. Full-width text separates horizontal
 * regions; persistent gutters split each region into any number of columns. */
export function readingOrderForLines(input: TextLine[]) {
  let nextFlow = 0;
  let columns = 1;
  let splitRegions = 0;
  const leaf = (lines: TextLine[]) => {
    const flowId = nextFlow++;
    const rows: TextLine[][] = [];
    for (const line of [...lines].sort(visual)) {
      const previous = rows[rows.length - 1];
      if (previous && Math.abs(centerY(previous[0]) - centerY(line)) <= Math.min(previous[0].fontSize, line.fontSize) * 0.5) previous.push(line);
      else rows.push([line]);
    }
    return rows.flatMap((row) => row.sort((a, b) => a.rect.left - b.rect.left)).map((line) => ({ ...line, flowId }));
  };
  const visit = (lines: TextLine[], depth: number, columnDepth = 1): TextLine[] => {
    if (!lines.length) return [];
    if (depth > 20 || lines.length < 6) return leaf(lines);
    const font = median(lines.map((line) => line.fontSize));
    const sorted = [...lines].sort(visual);
    // Large horizontal whitespace identifies separate slide/report sections.
    let extent = bottom(sorted[0]);
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index].rect.top - extent > font * 3.5) {
        return [...visit(sorted.slice(0, index), depth + 1, columnDepth), ...visit(sorted.slice(index), depth + 1, columnDepth)];
      }
      extent = Math.max(extent, bottom(sorted[index]));
    }
    const split = columnSplit(lines, font);
    if (!split) return leaf(lines);
    if (split.crossing.length) {
      // A title, full-width paragraph, equation, or table heading crossing the
      // gutter is a region boundary, including in the middle of a page.
      const bands: Array<{ top: number; bottom: number }> = [];
      for (const line of [...split.crossing].sort(visual)) {
        const previous = bands[bands.length - 1];
        if (previous && line.rect.top <= previous.bottom + font * 0.3) previous.bottom = Math.max(previous.bottom, bottom(line));
        else bands.push({ top: line.rect.top, bottom: bottom(line) });
      }
      const result: TextLine[] = [];
      let remaining = sorted;
      for (const band of bands) {
        const before = remaining.filter((line) => centerY(line) < band.top);
        const within = remaining.filter((line) => centerY(line) >= band.top && centerY(line) <= band.bottom);
        remaining = remaining.filter((line) => centerY(line) > band.bottom);
        result.push(...visit(before, depth + 1, columnDepth), ...leaf(within));
      }
      result.push(...visit(remaining, depth + 1, columnDepth));
      return result;
    }
    splitRegions += 1;
    columns = Math.max(columns, columnDepth + 1);
    return [...visit(split.left, depth + 1, columnDepth), ...visit(split.right, depth + 1, columnDepth + 1)];
  };
  const lastBottom = Math.max(0, ...input.map(bottom));
  const footers = input.filter((line) => /^(?:page\s*)?\d+(?:\s*\/\s*\d+)?$/i.test(line.text.trim())
    && bottom(line) >= lastBottom - line.fontSize
    && !input.some((other) => other !== line && Math.abs(centerY(other) - centerY(line)) < line.fontSize * 1.5));
  const lines = [...visit(input.filter((line) => !footers.includes(line)), 0), ...leaf(footers)];
  const ranges = new Map<number, { top: number; bottom: number }>();
  for (const line of lines) {
    const range = ranges.get(line.flowId!) ?? { top: line.rect.top, bottom: bottom(line) };
    range.top = Math.min(range.top, line.rect.top);
    range.bottom = Math.max(range.bottom, bottom(line));
    ranges.set(line.flowId!, range);
  }
  columns = Math.max(1, ...lines.map((line) => [...ranges.values()].filter((range) => centerY(line) >= range.top && centerY(line) <= range.bottom).length));
  return { lines, columns, splitRegions, flows: nextFlow };
}
