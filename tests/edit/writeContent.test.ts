import { describe, expect, it, vi } from 'vitest';
import {
  ContentWriteAfterCreateError,
  createDocumentFromMarkdown,
  writeBlocks,
} from '../../src/edit/writeContent.js';
import { DocsClient } from '../../src/api/client.js';
import { yjsBase64ToBlocks } from '../../src/content/convert.js';

function stubClient() {
  const client = new DocsClient(async () => new Response('{}', { status: 200 }));
  const patch = vi.spyOn(client, 'patchContent').mockResolvedValue(undefined);
  const create = vi
    .spyOn(client, 'createDocument')
    .mockResolvedValue({ id: 'new-id', title: 'New' });
  return { client, patch, create };
}

describe('writeBlocks', () => {
  it('sends base64 Yjs that decodes back to the same block types', async () => {
    const { client, patch } = stubClient();

    await writeBlocks(client, 'doc-1', [
      { type: 'paragraph', content: 'hello' },
    ] as never);

    const base64 = patch.mock.calls[0]?.[1] as string;
    expect(yjsBase64ToBlocks(base64).map((block) => block.type)).toContain('paragraph');
  });
});

describe('createDocumentFromMarkdown', () => {
  it('creates the document then writes its content', async () => {
    const { client, patch, create } = stubClient();

    const summary = await createDocumentFromMarkdown(client, {
      title: 'Notes',
      markdown: '# Notes\n\nBody',
    });

    expect(create).toHaveBeenCalledWith('Notes', undefined);
    expect(patch.mock.calls[0]?.[0]).toBe('new-id');
    expect(summary.id).toBe('new-id');
  });

  it('passes the parent through so the document is nested', async () => {
    const { client, create } = stubClient();

    await createDocumentFromMarkdown(client, {
      title: 'Child',
      markdown: 'x',
      parentId: 'parent-id',
    });

    expect(create).toHaveBeenCalledWith('Child', 'parent-id');
  });

  it('creates an empty document without writing content', async () => {
    const { client, patch } = stubClient();

    await createDocumentFromMarkdown(client, { title: 'Empty', markdown: '' });

    expect(patch).not.toHaveBeenCalled();
  });

  it('surfaces the created document id when the content write fails', async () => {
    const { client, patch } = stubClient();
    const writeFailure = new Error('Docs is rate limiting this client.');
    patch.mockRejectedValue(writeFailure);

    let thrown: unknown;
    try {
      await createDocumentFromMarkdown(client, { title: 'Notes', markdown: '# Notes' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContentWriteAfterCreateError);
    const error = thrown as ContentWriteAfterCreateError;
    expect(error.documentId).toBe('new-id');
    expect(error.message).toContain('new-id');
    expect(error.message).toContain('Docs is rate limiting this client.');
    expect(error.cause).toBe(writeFailure);
  });
});
