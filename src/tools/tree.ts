import { z } from 'zod';

import type { DocsClient } from '../api/client.js';
import { renderTree, toolResult } from './format.js';
import type { McpServerLike } from './types.js';

export function registerTreeTool(server: McpServerLike, client: DocsClient): void {
  server.registerTool(
    'docs_tree',
    {
      description:
        'Show the document hierarchy around a document: its ancestors and its children. ' +
        'Cheaper than reading content when orienting in a wiki.',
      inputSchema: z.object({ id: z.string().describe('Document UUID') }),
    },
    async ({ id }: { id: string }) => toolResult(renderTree(await client.getTree(id))),
  );
}
