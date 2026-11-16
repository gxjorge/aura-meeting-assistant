export type AnswerMarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; content: AnswerMarkdownInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; url: string; content: AnswerMarkdownInline[] };

export type AnswerMarkdownBlock =
  | { type: 'paragraph'; content: AnswerMarkdownInline[] }
  | { type: 'heading'; level: 1 | 2 | 3; content: AnswerMarkdownInline[] }
  | { type: 'list'; ordered: boolean; items: AnswerMarkdownInline[][] }
  | { type: 'table'; headers: AnswerMarkdownInline[][]; rows: AnswerMarkdownInline[][][] }
  | { type: 'quote'; content: AnswerMarkdownInline[] }
  | { type: 'code'; language?: string; text: string }
  | { type: 'rule' };

export function parseAnswerMarkdown(markdown: string): AnswerMarkdownBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: AnswerMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const codeFence = /^\s*```(?<language>[a-z0-9_-]+)?\s*$/i.exec(line);
    if (codeFence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({
        type: 'code',
        ...(codeFence.groups?.language ? { language: codeFence.groups.language } : {}),
        text: codeLines.join('\n'),
      });
      continue;
    }

    const heading = /^\s{0,3}(?<marks>#{1,3})\s+(?<content>.+)$/.exec(line);
    if (heading?.groups) {
      blocks.push({
        type: 'heading',
        level: heading.groups.marks.length as 1 | 2 | 3,
        content: parseAnswerInline(heading.groups.content.trim()),
      });
      index += 1;
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }

    const table = readTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.nextIndex;
      continue;
    }

    const listItem = matchListItem(line);
    if (listItem) {
      const ordered = listItem.ordered;
      const items: AnswerMarkdownInline[][] = [];
      while (index < lines.length) {
        const item = matchListItem(lines[index] ?? '');
        if (!item || item.ordered !== ordered) break;
        items.push(parseAnswerInline(item.content));
        index += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    const quote = /^>\s?(?<content>.*)$/.exec(line);
    if (quote) {
      const quoteLines: string[] = [];
      while (index < lines.length) {
        const quotedLine = /^>\s?(?<content>.*)$/.exec(lines[index] ?? '');
        if (!quotedLine?.groups) break;
        quoteLines.push(quotedLine.groups.content.trim());
        index += 1;
      }
      blocks.push({ type: 'quote', content: parseAnswerInline(quoteLines.join(' ')) });
      continue;
    }

    const paragraphLines: string[] = [];
    while (
      index < lines.length
      && lines[index]?.trim()
      && !startsMarkdownBlock(lines[index] ?? '')
      && !isTableStart(lines, index)
    ) {
      paragraphLines.push((lines[index] ?? '').trim());
      index += 1;
    }
    blocks.push({ type: 'paragraph', content: parseAnswerInline(paragraphLines.join(' ')) });
  }

  return blocks;
}

export function parseAnswerInline(value: string): AnswerMarkdownInline[] {
  const nodes: AnswerMarkdownInline[] = [];
  let index = 0;

  while (index < value.length) {
    if (value.startsWith('`', index)) {
      const end = value.indexOf('`', index + 1);
      if (end > index + 1) {
        pushInline(nodes, { type: 'code', text: value.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    if (value.startsWith('**', index)) {
      const end = value.indexOf('**', index + 2);
      if (end > index + 2) {
        pushInline(nodes, { type: 'strong', content: parseAnswerInline(value.slice(index + 2, end)) });
        index = end + 2;
        continue;
      }
    }

    if (value.startsWith('[', index)) {
      const link = readMarkdownLink(value, index);
      if (link) {
        pushInline(nodes, link.node);
        index = link.nextIndex;
        continue;
      }
    }

    const nextSpecial = findNextSpecial(value, index + 1);
    pushInline(nodes, { type: 'text', text: value.slice(index, nextSpecial) });
    index = nextSpecial;
  }

  return nodes;
}

function matchListItem(line: string): { ordered: boolean; content: string } | null {
  const match = /^\s{0,3}(?<marker>(?:[-*])|(?:\d+[.)]))\s+(?<content>.+)$/.exec(line);
  if (!match?.groups) return null;
  return {
    ordered: /^\d/.test(match.groups.marker),
    content: match.groups.content.trim(),
  };
}

function readTable(
  lines: string[],
  index: number,
): { block: Extract<AnswerMarkdownBlock, { type: 'table' }>; nextIndex: number } | null {
  const headerCells = splitTableRow(lines[index] ?? '');
  const separatorCells = splitTableRow(lines[index + 1] ?? '');

  if (!headerCells || !separatorCells || !isTableSeparator(separatorCells, headerCells.length)) {
    return null;
  }

  const rows: AnswerMarkdownInline[][][] = [];
  let nextIndex = index + 2;

  while (nextIndex < lines.length) {
    const rowCells = splitTableRow(lines[nextIndex] ?? '');
    if (!rowCells || isTableSeparator(rowCells, headerCells.length)) break;

    rows.push(normalizeTableCells(rowCells, headerCells.length).map(parseAnswerInline));
    nextIndex += 1;
  }

  return {
    block: {
      type: 'table',
      headers: headerCells.map(parseAnswerInline),
      rows,
    },
    nextIndex,
  };
}

function isTableStart(lines: string[], index: number): boolean {
  const headerCells = splitTableRow(lines[index] ?? '');
  const separatorCells = splitTableRow(lines[index + 1] ?? '');
  return Boolean(headerCells && separatorCells && isTableSeparator(separatorCells, headerCells.length));
}

function splitTableRow(line: string): string[] | null {
  let row = line.trim();
  if (!row.includes('|')) return null;

  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !isEscapedAt(row, row.length - 1)) row = row.slice(0, -1);

  const cells: string[] = [];
  let cell = '';

  for (let index = 0; index < row.length; index += 1) {
    const character = row[index];
    if (character === '\\' && row[index + 1] === '|') {
      cell += '|';
      index += 1;
      continue;
    }

    if (character === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }

    cell += character;
  }

  cells.push(cell.trim());
  return cells.length > 1 ? cells : null;
}

function isTableSeparator(cells: string[], expectedCellCount: number): boolean {
  return cells.length === expectedCellCount
    && cells.length > 1
    && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function normalizeTableCells(cells: string[], expectedCellCount: number): string[] {
  const normalized = cells.slice(0, expectedCellCount);
  while (normalized.length < expectedCellCount) normalized.push('');
  return normalized;
}

function isEscapedAt(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
}

function startsMarkdownBlock(line: string): boolean {
  return /^\s*```/.test(line)
    || /^\s{0,3}#{1,3}\s+/.test(line)
    || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
    || matchListItem(line) !== null
    || /^>\s?/.test(line);
}

function readMarkdownLink(
  value: string,
  index: number,
): { node: AnswerMarkdownInline; nextIndex: number } | null {
  const labelEnd = value.indexOf(']', index + 1);
  if (labelEnd <= index + 1 || value[labelEnd + 1] !== '(') return null;

  const urlEnd = value.indexOf(')', labelEnd + 2);
  if (urlEnd <= labelEnd + 2) return null;

  const rawUrl = value.slice(labelEnd + 2, urlEnd).trim();
  const url = normalizeMarkdownUrl(rawUrl);
  if (!url) return null;

  return {
    node: {
      type: 'link',
      url,
      content: parseAnswerInline(value.slice(index + 1, labelEnd)),
    },
    nextIndex: urlEnd + 1,
  };
}

function normalizeMarkdownUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function findNextSpecial(value: string, start: number): number {
  const candidates = [
    value.indexOf('`', start),
    value.indexOf('**', start),
    value.indexOf('[', start),
  ].filter((position) => position >= 0);

  return candidates.length > 0 ? Math.min(...candidates) : value.length;
}

function pushInline(nodes: AnswerMarkdownInline[], node: AnswerMarkdownInline): void {
  const previous = nodes[nodes.length - 1];
  if (previous?.type === 'text' && node.type === 'text') {
    previous.text += node.text;
    return;
  }

  nodes.push(node);
}
