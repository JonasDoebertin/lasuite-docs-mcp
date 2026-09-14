import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  DocumentLockedError,
  LossyEditError,
  StaleDocumentError,
  UnreadableDocumentError,
  editDocument,
} from '../../src/edit/editDocument.js';
import { DocsClient } from '../../src/api/client.js';
import { blocksToYjsBase64, yjsBase64ToBlocks } from '../../src/content/convert.js';
import { YJS_FRAGMENT_KEY } from '../../src/content/editor.js';
import { ConversionError } from '../../src/edit/conversion.js';

const heading = (level: number, text: string) => ({
  type: 'heading',
  props: { level },
  content: text,
});
const para = (text: string) => ({ type: 'paragraph', content: text });

function stubClient(options: {
  blocks?: unknown[];
  canEdit?: boolean;
  etags?: (string | null)[];
  base64?: string;
} = {}) {
  const client = new DocsClient(async () => new Response('{}', { status: 200 }));
  const etags = options.etags ?? ['"v1"', '"v1"'];
  let etagCall = 0;

  vi.spyOn(client, 'canEdit').mockResolvedValue(options.canEdit ?? true);
  const getFormattedContent = vi.spyOn(client, 'getFormattedContent').mockResolvedValue(
    options.blocks ?? [heading(2, 'One'), para('a'), heading(2, 'Two'), para('b')],
  );
  // Clamps to the last entry so a test only needs to name the reads it cares
  // about, while still distinguishing an explicit null (the instance sends no
  // ETag on that read) from a short list.
  const getContentWithEtag = vi.spyOn(client, 'getContentWithEtag').mockImplementation(() => {
    const index = Math.min(etagCall++, etags.length - 1);
    return Promise.resolve({
      base64: options.base64 ?? '',
      etag: index < 0 ? null : etags[index] ?? null,
    });
  });
  const patch = vi.spyOn(client, 'patchContent').mockResolvedValue(undefined);

  return { client, patch, getFormattedContent, getContentWithEtag };
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

  it('writes through and reports the staleness check as unavailable when the instance sends no ETag', async () => {
    const { client, patch } = stubClient({ etags: [] });

    const result = await editDocument(client, {
      id: '1',
      operation: 'append',
      markdown: 'tail',
    });

    expect(patch).toHaveBeenCalled();
    expect(result.staleCheckPerformed).toBe(false);
  });

  it('reads the ETag before reading the blocks, to close the TOCTOU window', async () => {
    const { client, getFormattedContent, getContentWithEtag } = stubClient();

    await editDocument(client, { id: '1', operation: 'append', markdown: 'tail' });

    const firstEtagCall = getContentWithEtag.mock.invocationCallOrder[0]!;
    const firstBlocksCall = getFormattedContent.mock.invocationCallOrder[0]!;
    expect(firstEtagCall).toBeLessThan(firstBlocksCall);
  });

  it('proceeds when the document is genuinely empty', async () => {
    const emptyState = blocksToYjsBase64([]);
    const { client, patch } = stubClient({ blocks: [], base64: emptyState });

    const result = await editDocument(client, {
      id: '1',
      operation: 'append',
      markdown: 'tail',
    });

    expect(patch).toHaveBeenCalled();
    expect(result.blockCount).toBeGreaterThan(0);
  });

  it('proceeds when the raw state carries edit-history tombstones but decodes to no blocks', async () => {
    // A byte-length threshold would misfire here: ordinary insert/delete
    // cycles from real collaborative editing leave Yjs delete-set overhead
    // that has nothing to do with visible content. 20 cycles produce a
    // state well over 200 bytes -- larger than even a short real block --
    // while still decoding to zero blocks.
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment(YJS_FRAGMENT_KEY);
    for (let i = 0; i < 20; i += 1) {
      fragment.insert(0, [new Y.XmlText(`content ${i}`)]);
      fragment.delete(0, 1);
    }
    const stateWithTombstones = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64');
    ydoc.destroy();
    expect(Buffer.from(stateWithTombstones, 'base64').length).toBeGreaterThan(200);

    const { client, patch } = stubClient({ blocks: [], base64: stateWithTombstones });

    const result = await editDocument(client, {
      id: '1',
      operation: 'append',
      markdown: 'tail',
    });

    expect(patch).toHaveBeenCalled();
    expect(result.blockCount).toBeGreaterThan(0);
  });

  it('refuses when formatted-content reports no blocks but the raw state decodes to real content', async () => {
    const realState = blocksToYjsBase64([
      para('a real paragraph nobody told us about'),
    ] as never);
    const { client, patch } = stubClient({ blocks: [], base64: realState });

    await expect(
      editDocument(client, { id: '1', operation: 'append', markdown: 'tail' }),
    ).rejects.toThrow(UnreadableDocumentError);
    expect(patch).not.toHaveBeenCalled();
  });

  it('reports a concurrent edit as staleness rather than an unreadable document', async () => {
    // The ETag read and the blocks read are separate requests. A write that
    // empties the document between them leaves formatted-content reporting no
    // blocks while the already-captured raw state still decodes to real
    // content, which is indistinguishable from a falsely-empty read on the
    // snapshots alone. The moved ETag is what tells the two apart.
    const realState = blocksToYjsBase64([para('written before the concurrent edit')] as never);
    const { client, patch } = stubClient({
      blocks: [],
      base64: realState,
      etags: ['"v1"', '"v2"'],
    });

    await expect(
      editDocument(client, { id: '1', operation: 'append', markdown: 'tail' }),
    ).rejects.toThrow(StaleDocumentError);
    expect(patch).not.toHaveBeenCalled();
  });

  it('does not call an appearing ETag a concurrent edit when the first read had none', async () => {
    // An instance that sends no ETag on one read and one on the next has not
    // told us the document moved, only that the header is unreliable. Reading
    // a revision change into that would turn a genuine falsely-empty read into
    // a phantom "retry and it will work" that never resolves.
    const realState = blocksToYjsBase64([para('content the formatted read missed')] as never);
    const { client, patch } = stubClient({
      blocks: [],
      base64: realState,
      etags: [null, '"v2"'],
    });

    await expect(
      editDocument(client, { id: '1', operation: 'append', markdown: 'tail' }),
    ).rejects.toThrow(UnreadableDocumentError);
    expect(patch).not.toHaveBeenCalled();
  });

  it('refuses when formatted-content reports no blocks and the raw state cannot be decoded at all', async () => {
    const { client, patch } = stubClient({ blocks: [], base64: 'not valid base64 yjs state' });

    await expect(
      editDocument(client, { id: '1', operation: 'append', markdown: 'tail' }),
    ).rejects.toThrow(/could not be decoded locally/);
    expect(patch).not.toHaveBeenCalled();
  });

  it('surfaces a schema-drift write failure as a classified ConversionError', async () => {
    const { client, patch } = stubClient({
      blocks: [{ type: 'aBlockTypeThatDoesNotExist' }],
    });

    await expect(
      editDocument(client, { id: '1', operation: 'append', markdown: 'tail' }),
    ).rejects.toThrow(ConversionError);
    expect(patch).not.toHaveBeenCalled();
  });

  it('still aborts on a moved ETag when both reads return a real value', async () => {
    const { client, patch } = stubClient({ etags: ['"v1"', '"v2"'] });

    await expect(
      editDocument(client, { id: '1', operation: 'append', markdown: 'x' }),
    ).rejects.toThrow(StaleDocumentError);
    expect(patch).not.toHaveBeenCalled();
  });
});
