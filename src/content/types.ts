import type { PartialBlock } from '@blocknote/core';
import type {
  DocsBlockSchema,
  DocsInlineContentSchema,
  DocsStyleSchema,
} from './schema.js';

export type DocsBlock = PartialBlock<
  DocsBlockSchema,
  DocsInlineContentSchema,
  DocsStyleSchema
>;
