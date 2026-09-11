import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  withPageBreak,
} from '@blocknote/core';

import { CalloutBlock } from './Callout.js';
import { InterlinkingLinkInline } from './InterlinkingLinkInline.js';
import { PdfBlock } from './Pdf.js';
import { UploadLoaderBlock } from './UploadLoader.js';

// Must stay in sync with the frontend schema (BlockNoteEditor.tsx) so Yjs
// documents authored client-side round-trip without dropping nodes.
export const docsBlockNoteSchema = withPageBreak(
  BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      callout: CalloutBlock(),
      pdf: PdfBlock(),
      uploadLoader: UploadLoaderBlock(),
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      interlinkingLinkInline: InterlinkingLinkInline,
    },
  }),
);

export type DocsBlockSchema = typeof docsBlockNoteSchema.blockSchema;
export type DocsInlineContentSchema =
  typeof docsBlockNoteSchema.inlineContentSchema;
export type DocsStyleSchema = typeof docsBlockNoteSchema.styleSchema;
