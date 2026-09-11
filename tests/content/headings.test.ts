import { describe, expect, it } from 'vitest';
import {
  AnchorNotFoundError,
  indexHeadings,
  resolveAnchor,
} from '../../src/content/headings.js';
import type { DocsBlock } from '../../src/content/types.js';

const heading = (level: number, text: string): DocsBlock =>
  ({ type: 'heading', props: { level }, content: text }) as never;

const para = (text: string): DocsBlock =>
  ({ type: 'paragraph', content: text }) as never;

describe('indexHeadings', () => {
  it('returns an empty index for a document with no headings', () => {
    expect(indexHeadings([para('a'), para('b')])).toEqual([]);
  });

  it('ends a section at the next heading of equal level', () => {
    const blocks = [heading(2, 'One'), para('x'), heading(2, 'Two'), para('y')];
    const [first, second] = indexHeadings(blocks);

    expect(first).toMatchObject({ anchor: 'One', startIndex: 0, endIndex: 2 });
    expect(second).toMatchObject({ anchor: 'Two', startIndex: 2, endIndex: 4 });
  });

  it('includes nested lower-level headings inside the parent section', () => {
    const blocks = [heading(1, 'Top'), heading(2, 'Nested'), para('x'), heading(1, 'Next')];
    const [top] = indexHeadings(blocks);

    expect(top).toMatchObject({ anchor: 'Top', startIndex: 0, endIndex: 3 });
  });

  it('runs the final section to the end of the document', () => {
    const blocks = [para('intro'), heading(2, 'Last'), para('x'), para('y')];
    const [last] = indexHeadings(blocks);

    expect(last).toMatchObject({ startIndex: 1, endIndex: 4 });
  });

  it('disambiguates repeated heading text with a #n suffix', () => {
    const blocks = [heading(2, 'Setup'), para('x'), heading(2, 'Setup'), para('y')];
    const anchors = indexHeadings(blocks).map((entry) => entry.anchor);

    expect(anchors).toEqual(['Setup', 'Setup#2']);
  });
});

describe('resolveAnchor', () => {
  it('finds an entry by its anchor', () => {
    const entries = indexHeadings([heading(2, 'Setup'), para('x')]);
    expect(resolveAnchor(entries, 'Setup').startIndex).toBe(0);
  });

  it('throws AnchorNotFoundError listing the available anchors', () => {
    const entries = indexHeadings([heading(2, 'Setup'), heading(2, 'Usage')]);

    expect(() => resolveAnchor(entries, 'Missing')).toThrow(AnchorNotFoundError);
    expect(() => resolveAnchor(entries, 'Missing')).toThrow(/Setup, Usage/);
  });
});
