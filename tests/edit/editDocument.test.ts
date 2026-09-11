import { describe, expect, it, vi } from 'vitest';
import {
  DocumentLockedError,
  LossyEditError,
  StaleDocumentError,
  editDocument,
} from '../../src/edit/editDocument.js';
import { DocsClient } from '../../src/api/client.js';
import { yjsBase64ToBlocks } from '../../src/content/convert.js';

const heading = (level: number, text: string) => ({
  type: 'heading',
  props: { level },
  content: text,
});
const para = (text: string) => ({ type: 'paragraph', content: text });

function stubClient(options: {
  blocks?: unknown[];
  canEdit?: boolean;
  etags?: string[];
} = {}) {
  const client = new DocsClient(async () => new Response('{}', { status: 200 }));
  const etags = options.etags ?? ['"v1"', '"v1"'];
  let etagCall = 0;

  vi.spyOn(client, 'canEdit').mockResolvedValue(options.canEdit ?? true);
  vi.spyOn(client, 'getFormattedContent').mockResolvedValue(
    options.blocks ?? [heading(2, 'One'), para('a'), heading(2, 'Two'), para('b')],
  );
  vi.spyOn(client, 'getContentWithEtag').mockImplementation(() =>
    Promise.resolve({ base64: '', etag: etags[etagCall++] ?? etags.at(-1) ?? null }),
  );
  const patch = vi.spyOn(client, 'patchContent').mockResolvedValue(undefined);

  return { client, patch };
}

describe('editDocument', () => {
  it('appends without touching existing content', async () => {
    const { client, patch } = stubClient();

    const result = await editDocument(client, {
      id: '1',
      operation: 'append',
      markdown: 'tail',
    });

    const written = yjsBase64ToBlocks(patch.mock.calls[0]?.[1] as string);
    expect(written.length).toBeGreaterThan(4);
    expect(result.discarded).toEqual([]);
  });

  it('replaces only the targeted section', async () => {
    const { client, patch } = stubClient();

    await editDocument(client, {
      id: '1',
      operation: 'replace_section',
      markdown: '## One\n\nnew',
      section: 'One',
    });

    const written = yjsBase64ToBlocks(patch.mock.calls[0]?.[1] as string);
    const text = JSON.stringify(written);
    expect(text).toContain('new');
    expect(text).toContain('Two');
    expect(text).not.toContain('"a"');
  });

  it('refuses when another party holds the document open', async () => {
    const { client, patch } = stubClient({ canEdit: false });

    await expect(
      editDocument(client, { id: '1', operation: 'append', markdown: 'x' }),
    ).rejects.toThrow(DocumentLockedError);
    expect(patch).not.toHaveBeenCalled();
  });

  it('aborts when the document changed between read and write', async () => {
    const { client, patch } = stubClient({ etags: ['"v1"', '"v2"'] });

    await expect(
      editDocument(client, { id: '1', operation: 'append', markdown: 'x' }),
    ).rejects.toThrow(StaleDocumentError);
    expect(patch).not.toHaveBeenCalled();
  });

  it('refuses a whole-document replace that would discard a callout', async () => {
    const { client, patch } = stubClient({
      blocks: [{ type: 'callout', props: { emoji: '💡' }, content: 'keep me' }],
    });

    await expect(
      editDocument(client, { id: '1', operation: 'replace', markdown: 'new' }),
    ).rejects.toThrow(LossyEditError);
    expect(patch).not.toHaveBeenCalled();
  });

  it('proceeds with a lossy replace once confirmed, and reports what went', async () => {
    const { client, patch } = stubClient({
      blocks: [{ type: 'callout', props: { emoji: '💡' }, content: 'bye' }],
    });

    const result = await editDocument(client, {
      id: '1',
      operation: 'replace',
      markdown: 'new',
      confirmLossy: true,
    });

    expect(result.discarded).toEqual([{ type: 'callout', count: 1 }]);
    expect(patch).toHaveBeenCalled();
  });

  it('reports lossy discards for a section edit without requiring confirmation', async () => {
    const { client, patch } = stubClient({
      blocks: [heading(2, 'One'), { type: 'pdf', props: {} }, heading(2, 'Two')],
    });

    const result = await editDocument(client, {
      id: '1',
      operation: 'replace_section',
      markdown: '## One\n\nnew',
      section: 'One',
    });

    expect(result.discarded).toEqual([{ type: 'pdf', count: 1 }]);
    expect(patch).toHaveBeenCalled();
  });

  it('surfaces the available anchors for an unknown section', async () => {
    const { client } = stubClient();

    await expect(
      editDocument(client, {
        id: '1',
        operation: 'replace_section',
        markdown: 'x',
        section: 'Nope',
      }),
    ).rejects.toThrow(/One, Two/);
  });
});
