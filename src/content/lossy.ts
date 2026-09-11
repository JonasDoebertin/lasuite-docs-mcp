import type { DocsBlock } from './types.js';

// Block types with no markdown representation. Round-tripping a document
// through markdown silently destroys these, which is why edits splice blocks.
const NON_REPRESENTABLE_TYPES = new Set([
  'callout',
  'pdf',
  'uploadLoader',
  'pageBreak',
]);

export interface LossyFinding {
  type: string;
  count: number;
}

function countLossyBlocks(blocks: DocsBlock[], counts: Map<string, number>): void {
  for (const block of blocks) {
    const type = block.type;
    if (typeof type === 'string' && NON_REPRESENTABLE_TYPES.has(type)) {
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }

    // A callout nested under a bullet list item, say, round-trips through
    // Yjs perfectly well and is just as thoroughly destroyed by a markdown
    // round trip as a top-level one. Scanning only the top level would leave
    // this guard blind to exactly the content it exists to protect.
    const children = (block as { children?: DocsBlock[] }).children;
    if (Array.isArray(children) && children.length > 0) {
      countLossyBlocks(children, counts);
    }
  }
}

export function detectLossyBlocks(blocks: DocsBlock[]): LossyFinding[] {
  const counts = new Map<string, number>();
  countLossyBlocks(blocks, counts);
  return [...counts.entries()].map(([type, count]) => ({ type, count }));
}
