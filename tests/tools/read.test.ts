import { describe, expect, it, vi } from 'vitest';
import { readDocument } from '../../src/tools/read.js';
import { DocsClient } from '../../src/api/client.js';
import { blocksToYjsBase64 } from '../../src/content/convert.js';

function clientReturning(content: Record<'markdown' | 'json', unknown>) {
  const client = new DocsClient(async () => new Response('{}', { status: 200 }));
  vi.spyOn(client, 'getFormattedContent').mockImplementation((_id, format) =>
    Promise.resolve(content[format as 'markdown' | 'json']),
  );
  return client;
}

// Simulates an instance where formatted_content is disabled (as the startup
// probe would record it) so getFormattedContent must never be called --
// docs_read has to fall back to raw content plus local conversion instead.
function clientWithoutFormattedContent(blocks: unknown[]) {
  const client = new DocsClient(async () => new Response('{}', { status: 200 }));
  vi.spyOn(client, 'isActionEnabled').mockImplementation((action) =>
    action === 'formatted_content' ? false : true,
  );
  const getFormattedContent = vi.spyOn(client, 'getFormattedContent');
  vi.spyOn(client, 'getContentWithEtag').mockResolvedValue({
    base64: blocksToYjsBase64(blocks as never),
    etag: '"v1"',
  });
  return { client, getFormattedContent };
}

const heading = (level: number, text: string) => ({
  type: 'heading',
  props: { level },
  content: text,
});
const para = (text: string) => ({ type: 'paragraph', content: text });

describe('readDocument', () => {
  it('returns the whole document as markdown by default', async () => {
    const client = clientReturning({ markdown: '# Title\n\nBody', json: [] });

    await expect(readDocument(client, { id: '1' })).resolves.toContain('# Title');
  });

  it('returns only the requested section', async () => {
    const client = clientReturning({
      markdown: 'unused',
      json: [heading(2, 'One'), para('first'), heading(2, 'Two'), para('second')],
    });

    const output = await readDocument(client, { id: '1', section: 'Two' });

    expect(output).toContain('second');
    expect(output).not.toContain('first');
  });

  it('lists the available anchors when the section is unknown', async () => {
    const client = clientReturning({
      markdown: 'unused',
      json: [heading(2, 'One'), heading(2, 'Two')],
    });

    await expect(readDocument(client, { id: '1', section: 'Nope' })).rejects.toThrow(
      /One, Two/,
    );
  });

  it('returns an outline instead of content past maxChars', async () => {
    const client = clientReturning({
      markdown: '# Title\n\n' + 'x'.repeat(500),
      json: [heading(1, 'Title'), para('x'.repeat(500))],
    });

    const output = await readDocument(client, { id: '1', maxChars: 100 });

    expect(output).toContain('Title');
    expect(output).toContain('section');
    expect(output).not.toContain('x'.repeat(200));
  });

  it('reports an empty document plainly', async () => {
    const client = clientReturning({ markdown: '', json: [] });

    await expect(readDocument(client, { id: '1' })).resolves.toContain('empty');
  });

  it('directs to maxChars, not section, when a headingless document exceeds the limit', async () => {
    const client = clientReturning({
      markdown: 'x'.repeat(500),
      json: [para('x'.repeat(500))],
    });

    const output = await readDocument(client, { id: '1', maxChars: 100 });

    expect(output).toContain('maxChars');
    expect(output).not.toContain('section');
  });

  it('falls back to local conversion when formatted_content is unavailable', async () => {
    const { client, getFormattedContent } = clientWithoutFormattedContent([
      heading(1, 'Title'),
      para('Body from raw content'),
    ]);

    const output = await readDocument(client, { id: '1' });

    expect(output).toContain('Title');
    expect(output).toContain('Body from raw content');
    expect(getFormattedContent).not.toHaveBeenCalled();
  });

  it('falls back to local conversion for a section read when formatted_content is unavailable', async () => {
    const { client, getFormattedContent } = clientWithoutFormattedContent([
      heading(2, 'One'),
      para('first'),
      heading(2, 'Two'),
      para('second'),
    ]);

    const output = await readDocument(client, { id: '1', section: 'Two' });

    expect(output).toContain('second');
    expect(output).not.toContain('first');
    expect(getFormattedContent).not.toHaveBeenCalled();
  });

  it('prefers formatted_content when it is available', async () => {
    const client = clientReturning({ markdown: '# Preferred', json: [] });
    vi.spyOn(client, 'isActionEnabled').mockReturnValue(true);
    const getContentWithEtag = vi.spyOn(client, 'getContentWithEtag');

    await expect(readDocument(client, { id: '1' })).resolves.toContain('Preferred');
    expect(getContentWithEtag).not.toHaveBeenCalled();
  });
});
