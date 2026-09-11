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

  // The five tests above only ever touch BlockNote's default schema
  // (headings, paragraphs, bold, bullet lists), which would pass identically
  // if all four vendored block specs were deleted. Schema drift -- the
  // project's stated main risk -- lives entirely in the vendored types, so
  // the contract suite has to exercise them directly. These types have no
  // markdown syntax, so the blocks are built by hand rather than parsed.
  it('round-trips a callout block with its custom props intact', async () => {
    const blocks = [
      {
        type: 'callout' as const,
        props: { emoji: '🔥', backgroundColor: 'red' as const },
        content: 'Careful with this one',
      },
    ];

    const summary = await createDocumentFromMarkdown(client, {
      title: `contract-callout-${Date.now()}`,
      markdown: '',
    });
    await client.patchContent(summary.id, blocksToYjsBase64(blocks as never));

    const remoteBlocks = (await client.getFormattedContent(summary.id, 'json')) as Array<{
      type: string;
      props?: Record<string, unknown>;
    }>;

    const callout = remoteBlocks.find((block) => block.type === 'callout');
    expect(callout).toBeDefined();
    // Asserting the type alone is not enough: an unknown prop on a known
    // block is silently dropped rather than rejected, which is exactly the
    // kind of drift a type-only assertion would miss.
    expect(callout?.props?.emoji).toBe('🔥');
    expect(callout?.props?.backgroundColor).toBe('red');
  });

  it('round-trips a pdf block with its custom props intact', async () => {
    const blocks = [
      {
        type: 'pdf' as const,
        props: { url: 'https://example.org/doc.pdf', name: 'doc.pdf' },
      },
    ];

    const summary = await createDocumentFromMarkdown(client, {
      title: `contract-pdf-${Date.now()}`,
      markdown: '',
    });
    await client.patchContent(summary.id, blocksToYjsBase64(blocks as never));

    const remoteBlocks = (await client.getFormattedContent(summary.id, 'json')) as Array<{
      type: string;
      props?: Record<string, unknown>;
    }>;

    const pdf = remoteBlocks.find((block) => block.type === 'pdf');
    expect(pdf).toBeDefined();
    expect(pdf?.props?.url).toBe('https://example.org/doc.pdf');
    expect(pdf?.props?.name).toBe('doc.pdf');
  });

  it('round-trips a pageBreak block', async () => {
    const blocks = [{ type: 'pageBreak' as const }];

    const summary = await createDocumentFromMarkdown(client, {
      title: `contract-pagebreak-${Date.now()}`,
      markdown: '',
    });
    await client.patchContent(summary.id, blocksToYjsBase64(blocks as never));

    const remoteBlocks = (await client.getFormattedContent(summary.id, 'json')) as Array<{
      type: string;
    }>;

    expect(remoteBlocks.some((block) => block.type === 'pageBreak')).toBe(true);
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
