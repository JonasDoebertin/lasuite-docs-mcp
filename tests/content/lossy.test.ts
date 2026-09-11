import { describe, expect, it } from 'vitest';
import { detectLossyBlocks } from '../../src/content/lossy.js';
import type { DocsBlock } from '../../src/content/types.js';

const block = (type: string): DocsBlock => ({ type, content: '' }) as never;

const withChildren = (type: string, children: DocsBlock[]): DocsBlock =>
  ({ type, content: '', children }) as never;

describe('detectLossyBlocks', () => {
  it('reports nothing for blocks markdown can represent', () => {
    expect(detectLossyBlocks([block('paragraph'), block('heading')])).toEqual([]);
  });

  it('reports each Docs-specific block type that markdown cannot express', () => {
    const findings = detectLossyBlocks([block('callout'), block('pdf'), block('paragraph')]);

    expect(findings).toEqual(
      expect.arrayContaining([
        { type: 'callout', count: 1 },
        { type: 'pdf', count: 1 },
      ]),
    );
    expect(findings).toHaveLength(2);
  });

  it('counts repeated lossy blocks of the same type', () => {
    expect(detectLossyBlocks([block('callout'), block('callout')])).toEqual([
      { type: 'callout', count: 2 },
    ]);
  });

  it('reports page breaks and upload loaders', () => {
    const types = detectLossyBlocks([block('pageBreak'), block('uploadLoader')]).map((f) => f.type);
    expect(types).toEqual(expect.arrayContaining(['pageBreak', 'uploadLoader']));
  });

  it('finds a callout nested under a bullet list item', () => {
    const doc = [withChildren('bulletListItem', [block('callout')])];

    expect(detectLossyBlocks(doc)).toEqual([{ type: 'callout', count: 1 }]);
  });

  it('recurses through several levels of nesting', () => {
    const doc = [
      withChildren('bulletListItem', [
        withChildren('bulletListItem', [withChildren('bulletListItem', [block('pdf')])]),
      ]),
    ];

    expect(detectLossyBlocks(doc)).toEqual([{ type: 'pdf', count: 1 }]);
  });

  it('counts lossy blocks at both the top level and nested beneath it', () => {
    const doc = [block('callout'), withChildren('bulletListItem', [block('callout')])];

    expect(detectLossyBlocks(doc)).toEqual([{ type: 'callout', count: 2 }]);
  });

  it('ignores children that are not lossy while still finding their siblings', () => {
    const doc = [
      withChildren('bulletListItem', [block('paragraph'), block('uploadLoader')]),
    ];

    expect(detectLossyBlocks(doc)).toEqual([{ type: 'uploadLoader', count: 1 }]);
  });
});
