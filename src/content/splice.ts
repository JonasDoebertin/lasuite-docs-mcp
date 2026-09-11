import { indexHeadings, resolveAnchor } from './headings.js';
import type { DocsBlock } from './types.js';

export type SpliceOperation =
  | 'replace'
  | 'append'
  | 'prepend'
  | 'replace_section'
  | 'insert_after_section';

export interface SpliceResult {
  blocks: DocsBlock[];
  discarded: DocsBlock[];
}

type SectionOperation = 'replace_section' | 'insert_after_section';

const SECTION_OPERATIONS = new Set<SpliceOperation>([
  'replace_section',
  'insert_after_section',
]);

function isSectionOperation(operation: SpliceOperation): operation is SectionOperation {
  return SECTION_OPERATIONS.has(operation);
}

export function spliceBlocks(
  existing: DocsBlock[],
  incoming: DocsBlock[],
  operation: SpliceOperation,
  anchor?: string,
): SpliceResult {
  if (isSectionOperation(operation)) {
    if (!anchor) {
      throw new Error(`Operation "${operation}" requires a section anchor.`);
    }

    const entry = resolveAnchor(indexHeadings(existing), anchor);
    const before = existing.slice(0, entry.startIndex);
    const section = existing.slice(entry.startIndex, entry.endIndex);
    const after = existing.slice(entry.endIndex);

    if (operation === 'replace_section') {
      return { blocks: [...before, ...incoming, ...after], discarded: section };
    }
    return { blocks: [...before, ...section, ...incoming, ...after], discarded: [] };
  }

  switch (operation) {
    case 'replace':
      return { blocks: [...incoming], discarded: [...existing] };
    case 'append':
      return { blocks: [...existing, ...incoming], discarded: [] };
    case 'prepend':
      return { blocks: [...incoming, ...existing], discarded: [] };
  }
}
