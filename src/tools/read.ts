import { z } from 'zod';

import type { DocsClient } from '../api/client.js';
import { blocksToMarkdown, yjsBase64ToBlocks } from '../content/convert.js';
import { indexHeadings, resolveAnchor } from '../content/headings.js';
import type { DocsBlock } from '../content/types.js';
import { renderOutline, toolResult } from './format.js';
import type { McpServerLike } from './types.js';

export const DEFAULT_MAX_CHARS = 20_000;

// `formatted_content` is preferred whenever it might be available: it runs
// the instance's own converter and is authoritative regardless of the
// BlockNote version this project pins. Only a probe result that explicitly
// came back disabled falls back to reading the raw Yjs state and converting
// it locally -- `undefined` (never probed, e.g. in tests that construct a
// client directly) is treated the same as "available".
function prefersFormattedContent(client: DocsClient): boolean {
  return client.isActionEnabled('formatted_content') !== false;
}

async function getBlocks(client: DocsClient, id: string): Promise<DocsBlock[]> {
  if (prefersFormattedContent(client)) {
    return (await client.getFormattedContent(id, 'json')) as DocsBlock[];
  }
  const { base64 } = await client.getContentWithEtag(id);
  return yjsBase64ToBlocks(base64);
}

async function getMarkdown(client: DocsClient, id: string): Promise<string> {
  if (prefersFormattedContent(client)) {
    return (await client.getFormattedContent(id, 'markdown')) as string;
  }
  return blocksToMarkdown(await getBlocks(client, id));
}

export async function readDocument(
  client: DocsClient,
  params: { id: string; section?: string; maxChars?: number },
): Promise<string> {
  const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;

  if (params.section) {
    const blocks = await getBlocks(client, params.id);
    const entry = resolveAnchor(indexHeadings(blocks), params.section);
    const markdown = await blocksToMarkdown(blocks.slice(entry.startIndex, entry.endIndex));
    return markdown.trim().length > 0 ? markdown : 'This section is empty.';
  }

  const markdown = await getMarkdown(client, params.id);

  if (markdown.trim().length === 0) {
    return 'This document is empty.';
  }

  if (markdown.length <= maxChars) {
    return markdown;
  }

  const blocks = await getBlocks(client, params.id);
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
