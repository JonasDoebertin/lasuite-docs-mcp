import { z } from 'zod';

import type { DocsClient } from '../api/client.js';
import { editDocument } from '../edit/editDocument.js';
import { toolResult } from './format.js';
import type { McpServerLike } from './types.js';

export function registerEditTool(server: McpServerLike, client: DocsClient): void {
  server.registerTool(
    'docs_edit',
    {
      description:
        'Edit an existing Docs document with markdown. Operations: replace (whole ' +
        'document), append, prepend, replace_section, insert_after_section. Section ' +
        'operations need a heading anchor from docs_read. Content outside the edited ' +
        'range is preserved exactly, including blocks markdown cannot express.',
      inputSchema: z.object({
        id: z.string().describe('Document UUID'),
        operation: z.enum([
          'replace',
          'append',
          'prepend',
          'replace_section',
          'insert_after_section',
        ]),
        markdown: z.string(),
        section: z
          .string()
          .optional()
          .describe('Heading anchor, required for section operations'),
        confirmLossy: z
          .boolean()
          .optional()
          .describe('Allow a whole-document replace to discard non-markdown blocks'),
      }),
    },
    async (params) => {
      const result = await editDocument(client, params);
      const lost =
        result.discarded.length > 0
          ? `\nDiscarded: ${result.discarded.map((f) => `${f.count}x ${f.type}`).join(', ')}`
          : '';
      const staleWarning = result.staleCheckPerformed
        ? ''
        : '\nNote: this Docs instance sent no ETag, so concurrent-modification ' +
          'detection was unavailable for this write.';

      return toolResult(
        `Applied ${result.operation}. Document now has ${result.blockCount} blocks.${lost}${staleWarning}`,
      );
    },
  );
}
