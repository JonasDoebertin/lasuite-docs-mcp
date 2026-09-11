import { describe, expect, it } from 'vitest';
import { editInputSchema } from '../../src/tools/edit.js';

const base = { id: '1', markdown: 'text' };

describe('editInputSchema', () => {
  it('accepts a section operation with a section', () => {
    const result = editInputSchema.safeParse({
      ...base,
      operation: 'replace_section',
      section: 'Setup',
    });

    expect(result.success).toBe(true);
  });

  it('accepts insert_after_section with a section', () => {
    const result = editInputSchema.safeParse({
      ...base,
      operation: 'insert_after_section',
      section: 'Setup',
    });

    expect(result.success).toBe(true);
  });

  it('accepts replace, append, and prepend with no section', () => {
    for (const operation of ['replace', 'append', 'prepend'] as const) {
      const result = editInputSchema.safeParse({ ...base, operation });
      expect(result.success).toBe(true);
    }
  });

  it('rejects section on replace', () => {
    const result = editInputSchema.safeParse({
      ...base,
      operation: 'replace',
      section: 'Setup',
    });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('section');
  });

  it('rejects section on append', () => {
    const result = editInputSchema.safeParse({
      ...base,
      operation: 'append',
      section: 'Setup',
    });

    expect(result.success).toBe(false);
  });

  it('rejects section on prepend', () => {
    const result = editInputSchema.safeParse({
      ...base,
      operation: 'prepend',
      section: 'Setup',
    });

    expect(result.success).toBe(false);
  });
});
