import { describe, expect, it } from 'vitest';
import { documentUri, parseDocumentUri } from '../../src/resources/documents.js';

describe('document URIs', () => {
  it('builds a docs:// URI from an id', () => {
    expect(documentUri('abc-123')).toBe('docs://document/abc-123');
  });

  it('round-trips an id', () => {
    expect(parseDocumentUri(documentUri('abc-123'))).toBe('abc-123');
  });

  it('rejects a URI with the wrong scheme', () => {
    expect(() => parseDocumentUri('https://document/abc')).toThrow(/docs:\/\/document/);
  });

  it('rejects a URI with no id', () => {
    expect(() => parseDocumentUri('docs://document/')).toThrow(/docs:\/\/document/);
  });
});
