import { describe, expect, it } from 'vitest';
import { spliceBlocks } from '../../src/content/splice.js';
import { AnchorNotFoundError } from '../../src/content/headings.js';
import type { DocsBlock } from '../../src/content/types.js';

const heading = (level: number, text: string): DocsBlock =>
  ({ type: 'heading', props: { level }, content: text }) as never;

const para = (text: string): DocsBlock =>
  ({ type: 'paragraph', content: text }) as never;

const texts = (blocks: DocsBlock[]) =>
  blocks.map((block) => (block as { content?: string }).content);

describe('spliceBlocks', () => {
  const doc = [heading(2, 'One'), para('a'), heading(2, 'Two'), para('b')];

  it('replace discards the whole document', () => {
    const result = spliceBlocks(doc, [para('new')], 'replace');

    expect(texts(result.blocks)).toEqual(['new']);
    expect(result.discarded).toHaveLength(4);
  });

  it('append adds to the end and discards nothing', () => {
    const result = spliceBlocks(doc, [para('new')], 'append');

    expect(texts(result.blocks)).toEqual(['One', 'a', 'Two', 'b', 'new']);
    expect(result.discarded).toEqual([]);
  });

  it('prepend adds to the start and discards nothing', () => {
    const result = spliceBlocks(doc, [para('new')], 'prepend');

    expect(texts(result.blocks)).toEqual(['new', 'One', 'a', 'Two', 'b']);
    expect(result.discarded).toEqual([]);
  });

  it('replace_section swaps only the targeted section', () => {
    const result = spliceBlocks(doc, [para('new')], 'replace_section', 'One');

    expect(texts(result.blocks)).toEqual(['new', 'Two', 'b']);
    expect(texts(result.discarded)).toEqual(['One', 'a']);
  });

  it('insert_after_section keeps the section and inserts behind it', () => {
    const result = spliceBlocks(doc, [para('new')], 'insert_after_section', 'One');

    expect(texts(result.blocks)).toEqual(['One', 'a', 'new', 'Two', 'b']);
    expect(result.discarded).toEqual([]);
  });

  it('leaves blocks outside the edited section untouched by identity', () => {
    const result = spliceBlocks(doc, [para('new')], 'replace_section', 'One');

    expect(result.blocks[1]).toBe(doc[2]);
    expect(result.blocks[2]).toBe(doc[3]);
  });

  it('rejects a section operation with no anchor', () => {
    expect(() => spliceBlocks(doc, [para('x')], 'replace_section')).toThrow(
      /requires a section anchor/,
    );
  });

  it('rejects an anchor that does not exist', () => {
    expect(() => spliceBlocks(doc, [para('x')], 'replace_section', 'Nope')).toThrow(
      AnchorNotFoundError,
    );
  });

  it('appends into an empty document', () => {
    expect(texts(spliceBlocks([], [para('new')], 'append').blocks)).toEqual(['new']);
  });
});
