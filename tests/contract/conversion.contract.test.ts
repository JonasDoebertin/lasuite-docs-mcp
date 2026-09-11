import { beforeAll, describe, expect, it } from 'vitest';

import { DocsClient } from '../../src/api/client.js';
import { createAuthenticatedFetch } from '../../src/auth/client.js';
import { loadConfig } from '../../src/config/index.js';
import { blocksToYjsBase64, markdownToBlocks } from '../../src/content/convert.js';
import { createDocumentFromMarkdown } from '../../src/edit/writeContent.js';
import { editDocument } from '../../src/edit/editDocument.js';

let client: DocsClient;

beforeAll(() => {
  client = new DocsClient(createAuthenticatedFetch(loadConfig(process.env)));
});

describe('conversion contract', () => {
  it('accepts locally generated Yjs and reads it back as equivalent markdown', async () => {
    const markdown = '# Contract\n\nA paragraph with **bold** text.\n\n## Section\n\n- one\n- two';

    const summary = await createDocumentFromMarkdown(client, {
      title: `contract-${Date.now()}`,
      markdown,
    });

    const readBack = (await client.getFormattedContent(summary.id, 'markdown')) as string;

    expect(readBack).toContain('# Contract');
    expect(readBack).toContain('**bold**');
    expect(readBack).toContain('## Section');
    expect(readBack).toContain('one');
  });

  it('agrees with the instance converter on block structure', async () => {
    const markdown = '# Heading\n\nBody text.';
    const localBlocks = await markdownToBlocks(markdown);

    const summary = await createDocumentFromMarkdown(client, {
      title: `contract-blocks-${Date.now()}`,
      markdown,
    });

    const remoteBlocks = (await client.getFormattedContent(summary.id, 'json')) as Array<{
      type: string;
    }>;

    expect(remoteBlocks.map((block) => block.type)).toEqual(
      localBlocks.map((block) => block.type),
    );
  });

  it('preserves a section edit against a real document', async () => {
    const summary = await createDocumentFromMarkdown(client, {
      title: `contract-edit-${Date.now()}`,
      markdown: '## One\n\nfirst\n\n## Two\n\nsecond',
    });

    await editDocument(client, {
      id: summary.id,
      operation: 'replace_section',
      markdown: '## One\n\nrewritten',
      section: 'One',
    });

    const readBack = (await client.getFormattedContent(summary.id, 'markdown')) as string;

    expect(readBack).toContain('rewritten');
    expect(readBack).toContain('second');
    expect(readBack).not.toContain('first');
  });

  it('round-trips an empty document without error', async () => {
    const summary = await createDocumentFromMarkdown(client, {
      title: `contract-empty-${Date.now()}`,
      markdown: '',
    });

    await expect(client.getFormattedContent(summary.id, 'markdown')).resolves.toBe('');
  });

  it('produces base64 the backend accepts for a direct content write', async () => {
    const summary = await createDocumentFromMarkdown(client, {
      title: `contract-patch-${Date.now()}`,
      markdown: 'initial',
    });

    const blocks = await markdownToBlocks('patched directly');
    await expect(
      client.patchContent(summary.id, blocksToYjsBase64(blocks)),
    ).resolves.toBeUndefined();

    const readBack = (await client.getFormattedContent(summary.id, 'markdown')) as string;

    expect(readBack).toContain('patched directly');
    expect(readBack).not.toContain('initial');
  });
});
