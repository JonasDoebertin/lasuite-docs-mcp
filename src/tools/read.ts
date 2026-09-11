import { z } from 'zod';

import type { DocsClient } from '../api/client.js';
import { blocksToMarkdown } from '../content/convert.js';
import { indexHeadings, resolveAnchor } from '../content/headings.js';
import type { DocsBlock } from '../content/types.js';
import { renderOutline, toolResult } from './format.js';
import type { McpServerLike } from './types.js';

export const DEFAULT_MAX_CHARS = 20_000;

export async function readDocument(
  client: DocsClient,
  params: { id: string; section?: string; maxChars?: number },
): Promise<string> {
  const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;

  if (params.section) {
    const blocks = (await client.getFormattedContent(params.id, 'json')) as DocsBlock[];
    const entry = resolveAnchor(indexHeadings(blocks), params.section);
    const markdown = await blocksToMarkdown(blocks.slice(entry.startIndex, entry.endIndex));
    return markdown.trim().length > 0 ? markdown : 'This section is empty.';
  }

  const markdown = (await client.getFormattedContent(params.id, 'markdown')) as string;

  if (markdown.trim().length === 0) {
    return 'This document is empty.';
  }

  if (markdown.length <= maxChars) {
    return markdown;
  }

  const blocks = (await client.getFormattedContent(params.id, 'json')) as DocsBlock[];
  const headings = indexHeadings(blocks);

  if (headings.length === 0) {
    return (
      `This document is ${markdown.length} characters, over the ${maxChars} limit, ` +
      'and has no headings to read in parts. Call docs_read again with a larger ' +
      '"maxChars" to read it in full.'
    );
  }

  const outline = renderOutline(headings);

  return (
    `This document is ${markdown.length} characters, over the ${maxChars} limit, ` +
    'so here is its outline instead. Call docs_read again with a "section" ' +
    `argument set to one of these anchors:\n\n${outline}`
  );
}

export function registerReadTool(server: McpServerLike, client: DocsClient): void {
  server.registerTool(
    'docs_read',
    {
      description:
        'Read a Docs document as markdown. Pass "section" to read only one heading. ' +
        'Large documents return an outline of section anchors instead of full content.',
      inputSchema: z.object({
        id: z.string().describe('Document UUID'),
        section: z.string().optional().describe('Heading anchor, e.g. "Setup" or "Setup#2"'),
        maxChars: z.number().int().positive().optional(),
      }),
    },
    async (params) => toolResult(await readDocument(client, params)),
  );
}
