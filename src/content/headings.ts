import type { DocsBlock } from './types.js';

export interface HeadingEntry {
  anchor: string;
  text: string;
  level: number;
  startIndex: number;
  endIndex: number;
}

export class AnchorNotFoundError extends Error {
  constructor(anchor: string, available: string[]) {
    const known = available.length > 0 ? available.join(', ') : 'none';
    super(`No heading matches "${anchor}". Available anchors: ${known}`);
    this.name = 'AnchorNotFoundError';
  }
}

export class AmbiguousAnchorError extends Error {
  constructor(anchor: string) {
    super(
      `Anchor "${anchor}" is ambiguous: the document contains both a literal heading with this ` +
        'text and a generated duplicate-suffix anchor that collides with it. Rename one of the ' +
        'headings to disambiguate.',
    );
    this.name = 'AmbiguousAnchorError';
  }
}

export function blockText(block: DocsBlock): string {
  const content = (block as { content?: unknown }).content;

  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => (typeof part === 'string' ? part : ((part as { text?: string }).text ?? '')))
    .join('');
}

function headingLevel(block: DocsBlock): number | null {
  if (block.type !== 'heading') {
    return null;
  }
  const level = (block.props as { level?: number } | undefined)?.level;
  return typeof level === 'number' ? level : 1;
}

export function indexHeadings(blocks: DocsBlock[]): HeadingEntry[] {
  const entries: HeadingEntry[] = [];
  const seen = new Map<string, number>();

  blocks.forEach((block, index) => {
    const level = headingLevel(block);
    if (level === null) {
      return;
    }

    const text = blockText(block);
    const occurrence = (seen.get(text) ?? 0) + 1;
    seen.set(text, occurrence);

    entries.push({
      anchor: occurrence === 1 ? text : `${text}#${occurrence}`,
      text,
      level,
      startIndex: index,
      endIndex: blocks.length,
    });
  });

  entries.forEach((entry, position) => {
    const next = entries
      .slice(position + 1)
      .find((candidate) => candidate.level <= entry.level);
    entry.endIndex = next ? next.startIndex : blocks.length;
  });

  return entries;
}

export function resolveAnchor(entries: HeadingEntry[], anchor: string): HeadingEntry {
  const matches = entries.filter((entry) => entry.anchor === anchor);
  if (matches.length === 0) {
    throw new AnchorNotFoundError(anchor, entries.map((entry) => entry.anchor));
  }
  if (matches.length > 1) {
    throw new AmbiguousAnchorError(anchor);
  }
  return matches[0]!;
}
