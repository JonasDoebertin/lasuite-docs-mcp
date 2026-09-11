import { describe, expect, it } from 'vitest';
import { DocsApiError, toDocsApiError } from '../../src/api/errors.js';

const response = (status: number, headers: Record<string, string> = {}) =>
  new Response('', { status, headers });

describe('toDocsApiError', () => {
  it('maps 401 to unauthenticated and names the login command', () => {
    const error = toDocsApiError(response(401), { action: 'list' });

    expect(error).toBeInstanceOf(DocsApiError);
    expect(error.kind).toBe('unauthenticated');
    expect(error.message).toContain('lasuite-docs-mcp login');
  });

  it('maps 403 to action_disabled when the probe found the action disabled', () => {
    const error = toDocsApiError(response(403), { action: 'search', actionEnabled: false });

    expect(error.kind).toBe('action_disabled');
    expect(error.message).toContain('EXTERNAL_API');
    expect(error.message).toContain('search');
  });

  it('maps 403 to forbidden when the action is known to be enabled', () => {
    const error = toDocsApiError(response(403), { action: 'retrieve', actionEnabled: true });

    expect(error.kind).toBe('forbidden');
    expect(error.message).not.toContain('EXTERNAL_API');
  });

  it('maps 404 without claiming the document is absent', () => {
    const error = toDocsApiError(response(404), { action: 'retrieve' });

    expect(error.kind).toBe('not_found');
    expect(error.message).toMatch(/may not exist or may not be readable/);
  });

  it('maps 429 and surfaces Retry-After', () => {
    const error = toDocsApiError(response(429, { 'retry-after': '30' }), { action: 'search' });

    expect(error.kind).toBe('throttled');
    expect(error.message).toContain('30');
  });

  it('maps 412 to conflict', () => {
    expect(toDocsApiError(response(412), { action: 'content' }).kind).toBe('conflict');
  });

  it('maps 5xx to server', () => {
    expect(toDocsApiError(response(503), { action: 'list' }).kind).toBe('server');
  });
});
