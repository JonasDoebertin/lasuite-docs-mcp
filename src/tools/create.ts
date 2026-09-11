import { z } from 'zod';

import type { DocsClient } from '../api/client.js';
import { createDocumentFromMarkdown } from '../edit/writeContent.js';
import { toolResult } from './format.js';
import type { McpServerLike } from './types.js';

export function registerCreateTool(server: McpServerLike, client: DocsClient): void {
  server.registerTool(
    'docs_create',
    {
      description:
        'Create a new Docs document from markdown. Pass parentId to nest it under ' +
        'an existing document.',
      inputSchema: z.object({
        title: z.string().min(1),
        markdown: z.string().default(''),
        parentId: z.string().optional().describe('UUID of the parent document'),
      }),
    },
    async (params) => {
      const summary = await createDocumentFromMarkdown(client, params);
      return toolResult(`Created "${summary.title}"\nid: ${summary.id}`);
    },
  );
}
