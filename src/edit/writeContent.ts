import type { DocsClient } from '../api/client.js';
import type { DocumentSummary } from '../api/types.js';
import { blocksToYjsBase64, markdownToBlocks } from '../content/convert.js';
import type { DocsBlock } from '../content/types.js';

export async function writeBlocks(
  client: DocsClient,
  id: string,
  blocks: DocsBlock[],
): Promise<void> {
  await client.patchContent(id, blocksToYjsBase64(blocks));
}

export async function createDocumentFromMarkdown(
  client: DocsClient,
  params: { title: string; markdown: string; parentId?: string },
): Promise<DocumentSummary> {
  const summary = await client.createDocument(params.title, params.parentId);

  if (params.markdown.trim().length > 0) {
    await writeBlocks(client, summary.id, await markdownToBlocks(params.markdown));
  }

  return summary;
}
