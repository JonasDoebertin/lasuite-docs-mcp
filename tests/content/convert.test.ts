import { describe, expect, it } from 'vitest';
import {
  blocksToMarkdown,
  blocksToYjsBase64,
  markdownToBlocks,
  yjsBase64ToBlocks,
} from '../../src/content/convert.js';

describe('content conversion', () => {
  it('round-trips markdown through Yjs without losing text', async () => {
    const markdown = '# Title\n\nA paragraph with **bold** text.\n\n## Section\n\n- one\n- two';

    const blocks = await markdownToBlocks(markdown);
    const base64 = blocksToYjsBase64(blocks);
    const restored = yjsBase64ToBlocks(base64);
    const output = await blocksToMarkdown(restored);

    expect(output).toContain('# Title');
    expect(output).toContain('**bold**');
    expect(output).toContain('## Section');
    expect(output).toContain('one');
    expect(output).toContain('two');
  });

  it('produces base64 that decodes to a non-empty Yjs update', async () => {
    const blocks = await markdownToBlocks('hello');
    const base64 = blocksToYjsBase64(blocks);

    expect(base64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(base64, 'base64').byteLength).toBeGreaterThan(0);
  });

  it('preserves a custom callout block across a Yjs round trip', async () => {
    const blocks = [
      { type: 'callout' as const, props: { emoji: '💡' }, content: 'Watch out' },
      { type: 'paragraph' as const, content: 'after' },
    ];

    const restored = yjsBase64ToBlocks(blocksToYjsBase64(blocks as never));
    const types = restored.map((block) => block.type);

    expect(types).toContain('callout');
    expect(types).toContain('paragraph');
  });

  it('treats an empty block list as a valid empty document', () => {
    const base64 = blocksToYjsBase64([]);
    expect(yjsBase64ToBlocks(base64)).toEqual([]);
  });
});
