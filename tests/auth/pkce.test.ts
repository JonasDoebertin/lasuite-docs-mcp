import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPkcePair } from '../../src/auth/pkce.js';

describe('createPkcePair', () => {
  it('produces a verifier within the RFC 7636 length bounds', () => {
    const { verifier } = createPkcePair();

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('produces a base64url verifier with no padding', () => {
    expect(createPkcePair().verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('derives the challenge as the base64url S256 hash of the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    const expected = createHash('sha256').update(verifier).digest('base64url');

    expect(challenge).toBe(expected);
  });

  it('produces a different verifier on each call', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});
