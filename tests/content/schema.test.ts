import { describe, expect, it } from 'vitest';
import { docsBlockNoteSchema } from '../../src/content/schema.js';

describe('vendored Docs schema', () => {
  it('registers the four Docs-specific specs on top of BlockNote defaults', () => {
    const blockTypes = Object.keys(docsBlockNoteSchema.blockSchema);
    expect(blockTypes).toContain('callout');
    expect(blockTypes).toContain('pdf');
    expect(blockTypes).toContain('uploadLoader');
    expect(blockTypes).toContain('pageBreak');
  });

  it('registers the interlinking inline content spec', () => {
    const inlineTypes = Object.keys(docsBlockNoteSchema.inlineContentSchema);
    expect(inlineTypes).toContain('interlinkingLinkInline');
  });

  it('still provides the default block types the editor relies on', () => {
    const blockTypes = Object.keys(docsBlockNoteSchema.blockSchema);
    expect(blockTypes).toContain('paragraph');
    expect(blockTypes).toContain('heading');
    expect(blockTypes).toContain('bulletListItem');
  });
});
