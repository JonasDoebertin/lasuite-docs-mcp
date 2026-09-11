import { describe, expect, it } from 'vitest';
import { renderDocumentList, renderOutline, renderTree } from '../../src/tools/format.js';

describe('renderDocumentList', () => {
  it('renders one line per document with the id', () => {
    const output = renderDocumentList([
      { id: 'abc', title: 'Spec', updatedAt: '2026-09-01T10:00:00Z' },
    ]);

    expect(output).toContain('Spec');
    expect(output).toContain('abc');
  });

  it('says so plainly when there are no results', () => {
    expect(renderDocumentList([])).toBe('No documents matched.');
  });

  it('includes the path when the document has one', () => {
    const output = renderDocumentList([{ id: 'abc', title: 'Spec', path: '/root/spec' }]);

    expect(output).toContain('path: /root/spec');
  });

  it('omits the path line entirely when the document has none', () => {
    const output = renderDocumentList([{ id: 'abc', title: 'Spec' }]);

    expect(output).not.toContain('path:');
  });
});

describe('renderTree', () => {
  it('indents children beneath their parent', () => {
    const output = renderTree({
      id: '1',
      title: 'Root',
      children: [{ id: '2', title: 'Child', children: [] }],
    });

    expect(output.split('\n')[0]).toContain('Root');
    expect(output.split('\n')[1]).toMatch(/^\s+.*Child/);
  });
});

describe('renderOutline', () => {
  it('lists anchors so the caller knows what to request', () => {
    const output = renderOutline([
      { anchor: 'Setup', text: 'Setup', level: 2, startIndex: 0, endIndex: 2 },
    ]);

    expect(output).toContain('Setup');
  });

  it('reports an empty outline for a document with no headings', () => {
    expect(renderOutline([])).toContain('no headings');
  });
});
