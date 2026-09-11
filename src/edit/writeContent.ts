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

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Docs has no atomic create-and-write: creation and the content write are
// two separate requests. If the write fails after the document already
// exists, the caller must not lose track of that document -- it is empty
// but real, and rolling it back with a delete would be a second destructive
// request layered on top of an already-failed one. Surfacing the id lets
// the caller retry the write or tell the user where the empty document is.
export class ContentWriteAfterCreateError extends Error {
  readonly documentId: string;
  readonly documentTitle: string;

  constructor(documentId: string, documentTitle: string, cause: unknown) {
    super(
      `Created "${documentTitle}" (id: ${documentId}) but failed to write its content: ` +
        `${describeCause(cause)}. The document exists and is empty; retry writing content ` +
        `against id ${documentId} rather than creating it again.`,
      { cause },
    );
    this.name = 'ContentWriteAfterCreateError';
    this.documentId = documentId;
    this.documentTitle = documentTitle;
  }
}

export async function createDocumentFromMarkdown(
  client: DocsClient,
  params: { title: string; markdown: string; parentId?: string },
): Promise<DocumentSummary> {
  const summary = await client.createDocument(params.title, params.parentId);

  if (params.markdown.trim().length > 0) {
    try {
      await writeBlocks(client, summary.id, await markdownToBlocks(params.markdown));
    } catch (cause) {
      throw new ContentWriteAfterCreateError(summary.id, summary.title, cause);
    }
  }

  return summary;
}
