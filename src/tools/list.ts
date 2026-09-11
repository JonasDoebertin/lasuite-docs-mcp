import { z } from 'zod';

import type { DocsClient } from '../api/client.js';
import { renderDocumentList, toolResult } from './format.js';
import type { McpServerLike } from './types.js';

export function registerListTool(server: McpServerLike, client: DocsClient): void {
  server.registerTool(
    'docs_list',
    {
      description:
        'Browse documents: recent, favorites, or those you created. ' +
        'Use docs_search when you have a query.',
      inputSchema: z.object({
        title: z.string().optional().describe('Substring match on the title'),
        isFavorite: z.boolean().optional(),
        isCreatorMe: z.boolean().optional(),
        ordering: z
          .enum(['created_at', '-created_at', 'updated_at', '-updated_at', 'title', '-title'])
          .optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
    },
    async (params) =>
      toolResult(
        renderDocumentList(
          await client.listDocuments({
            title: params.title,
            isFavorite: params.isFavorite,
            isCreatorMe: params.isCreatorMe,
            ordering: params.ordering ?? '-updated_at',
            pageSize: params.limit ?? 20,
          }),
        ),
      ),
  );
}
