import { describe, expect, it } from 'vitest';
import {
  ConversionError,
  convertBlocksToYjsBase64,
  convertMarkdownToBlocks,
} from '../../src/edit/conversion.js';

describe('convertMarkdownToBlocks', () => {
  it('converts valid markdown without error', async () => {
    await expect(convertMarkdownToBlocks('# Title\n\nBody')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'heading' })]),
    );
  });
});

describe('convertBlocksToYjsBase64', () => {
  it('converts a well-formed block array without error', () => {
    expect(() =>
      convertBlocksToYjsBase64([{ type: 'paragraph', content: 'hello' }] as never),
    ).not.toThrow();
  });

  it('wraps a schema-drift failure as a ConversionError naming the offending block type', () => {
    let thrown: unknown;
    try {
      convertBlocksToYjsBase64([{ type: 'aBlockTypeThatDoesNotExist' }] as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConversionError);
    const error = thrown as ConversionError;
    expect(error.message).toContain('aBlockTypeThatDoesNotExist');
    expect(error.message).toContain('npm run vendor');
    expect(error.message).toContain('npm run test:contract');
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('finds an unknown block type nested under a known one', () => {
    let thrown: unknown;
    try {
      convertBlocksToYjsBase64([
        {
          type: 'bulletListItem',
          content: '',
          children: [{ type: 'aBlockTypeThatDoesNotExist' }],
        },
      ] as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConversionError);
    expect((thrown as ConversionError).message).toContain('aBlockTypeThatDoesNotExist');
  });
});
