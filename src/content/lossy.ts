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

export function detectLossyBlocks(blocks: DocsBlock[]): LossyFinding[] {
  const counts = new Map<string, number>();

  for (const block of blocks) {
    const type = block.type;
    if (typeof type === 'string' && NON_REPRESENTABLE_TYPES.has(type)) {
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }

  return [...counts.entries()].map(([type, count]) => ({ type, count }));
}
