import { describe, expect, it, vi } from 'vitest';
import { DocsClient } from '../../src/api/client.js';
import { DocsApiError } from '../../src/api/errors.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function clientWith(handler: (path: string, init?: RequestInit) => Response) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new DocsClient(async (path, init) => {
    calls.push({ path, init });
    return handler(path, init);
  });
  return { client, calls };
}

describe('DocsClient', () => {
  it('unwraps the paginated results envelope when listing', async () => {
    const { client } = clientWith(() => json({ results: [{ id: '1', title: 'A' }] }));

    await expect(client.listDocuments()).resolves.toEqual([{ id: '1', title: 'A' }]);
  });

  it('accepts a bare array when the endpoint is not paginated', async () => {
    const { client } = clientWith(() => json([{ id: '1', title: 'A' }]));

    await expect(client.listFavorites()).resolves.toEqual([{ id: '1', title: 'A' }]);
  });

  it('passes list filters as query parameters', async () => {
    const { client, calls } = clientWith(() => json({ results: [] }));

    await client.listDocuments({ title: 'spec', isFavorite: true, pageSize: 5 });

    expect(calls[0]?.path).toContain('title=spec');
    expect(calls[0]?.path).toContain('is_favorite=true');
    expect(calls[0]?.path).toContain('page_size=5');
  });

  it('sends the search query to the search endpoint', async () => {
    const { client, calls } = clientWith(() => json({ results: [] }));

    await client.searchDocuments('release notes');

    expect(calls[0]?.path).toContain('documents/search/');
    expect(calls[0]?.path).toContain('q=release+notes');
  });

  it('returns markdown from the formatted-content envelope', async () => {
    const { client, calls } = clientWith(() =>
      json({ id: '1', title: 'A', content: '# Hi', created_at: null, updated_at: null }),
    );

    await expect(client.getFormattedContent('1', 'markdown')).resolves.toBe('# Hi');
    expect(calls[0]?.path).toContain('content_format=markdown');
  });

  it('treats null formatted content as an empty document', async () => {
    const { client } = clientWith(() => json({ id: '1', title: 'A', content: null }));

    await expect(client.getFormattedContent('1', 'markdown')).resolves.toBe('');
  });

  it('returns an empty block list for a null json content envelope', async () => {
    const { client } = clientWith(() => json({ id: '1', title: 'A', content: null }));

    await expect(client.getFormattedContent('1', 'json')).resolves.toEqual([]);
  });

  it('captures the ETag alongside raw content', async () => {
    const { client } = clientWith(
      () => new Response('YmFzZTY0', { status: 200, headers: { etag: '"abc"' } }),
    );

    await expect(client.getContentWithEtag('1')).resolves.toEqual({
      base64: 'YmFzZTY0',
      etag: '"abc"',
    });
  });

  it('never sends the websocket bypass flag when writing content', async () => {
    const { client, calls } = clientWith(() => new Response(null, { status: 204 }));

    await client.patchContent('1', 'YmFzZTY0');

    const body = String(calls[0]?.init?.body);
    expect(body).toContain('YmFzZTY0');
    expect(body).not.toContain('websocket');
  });

  it('reads the can_edit flag', async () => {
    const { client } = clientWith(() => json({ can_edit: false }));

    await expect(client.canEdit('1')).resolves.toBe(false);
  });

  it('creates a child document under a parent', async () => {
    const { client, calls } = clientWith(() => json({ id: '2', title: 'Child' }, 201));

    await client.createDocument('Child', 'parent-id');

    expect(calls[0]?.path).toBe('documents/parent-id/children/');
  });

  it('creates a root document when no parent is given', async () => {
    const { client, calls } = clientWith(() => json({ id: '2', title: 'Root' }, 201));

    await client.createDocument('Root');

    expect(calls[0]?.path).toBe('documents/');
  });

  it('raises a classified error for a failed request', async () => {
    const { client } = clientWith(() => new Response('', { status: 404 }));

    await expect(client.getDocument('missing')).rejects.toThrow(DocsApiError);
    await expect(client.getDocument('missing')).rejects.toThrow(/may not exist/);
  });

  it('classifies a 403 as a configuration problem once the probe marks the action disabled', async () => {
    const { client } = clientWith(() => new Response('', { status: 403 }));
    client.setActionEnabled('search', false);

    await expect(client.searchDocuments('x')).rejects.toThrow(/EXTERNAL_API/);
  });
});
