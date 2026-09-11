import { describe, expect, it } from 'vitest';
import { detectLossyBlocks } from '../../src/content/lossy.js';
import type { DocsBlock } from '../../src/content/types.js';

const block = (type: string): DocsBlock => ({ type, content: '' }) as never;

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
});
