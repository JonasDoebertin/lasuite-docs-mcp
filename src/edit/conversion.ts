import { blocksToYjsBase64, markdownToBlocks } from '../content/convert.js';
import { docsBlockNoteSchema } from '../content/schema.js';
import type { DocsBlock } from '../content/types.js';

const REMEDIATION =
  'This may mean the vendored block schema has drifted from this Docs instance. ' +
  'Run `npm run vendor` to refresh it, then `npm run test:contract` against a ' +
  'live instance before trusting writes again.';

// Conversion failures reach here as whatever @blocknote/server-util happens
// to throw internally -- typically a bare TypeError like "Cannot read
// properties of undefined (reading 'isInGroup')" from a block-spec lookup
// that found nothing. That message means nothing to an agent deciding what
// to do next. The spec asks conversion failures to "report where it failed
// and write nothing"; writing nothing already happens because these wrap the
// call, not the write, but reporting where did not until now.
export class ConversionError extends Error {
  constructor(message: string, cause: unknown) {
    super(`${message} ${REMEDIATION}`, { cause });
    this.name = 'ConversionError';
  }
}

function findUnknownBlockType(blocks: DocsBlock[]): string | undefined {
  for (const block of blocks) {
    const type = block.type;
    if (typeof type === 'string' && !(type in docsBlockNoteSchema.blockSchema)) {
      return type;
    }

    const children = (block as { children?: DocsBlock[] }).children;
    if (Array.isArray(children) && children.length > 0) {
      const found = findUnknownBlockType(children);
      if (found) return found;
    }
  }
  return undefined;
}

export async function convertMarkdownToBlocks(markdown: string): Promise<DocsBlock[]> {
  try {
    return await markdownToBlocks(markdown);
  } catch (cause) {
    throw new ConversionError('Failed to convert markdown to blocks.', cause);
  }
}

export function convertBlocksToYjsBase64(blocks: DocsBlock[]): string {
  try {
    return blocksToYjsBase64(blocks);
  } catch (cause) {
    const unknownType = findUnknownBlockType(blocks);
    const detail = unknownType
      ? `block type "${unknownType}" is not in the vendored schema`
      : 'a block carries a shape the vendored schema does not expect';
    throw new ConversionError(`Failed to convert blocks to a Yjs document (${detail}).`, cause);
  }
}
