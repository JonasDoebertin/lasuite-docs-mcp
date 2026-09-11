import { z } from 'zod';

import type { DocsClient } from '../api/client.js';
import { renderDocumentList, toolResult } from './format.js';
import type { McpServerLike } from './types.js';

export function registerSearchTool(server: McpServerLike, client: DocsClient): void {
  server.registerTool(
    'docs_search',
    {
      description:
        'Search documents on the Docs instance by text. Returns titles and ids; ' +
        'use docs_read to fetch content.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
      }),
    },
    async ({ query, limit }) =>
      toolResult(renderDocumentList(await client.searchDocuments(query, limit ?? 20))),
  );
}
