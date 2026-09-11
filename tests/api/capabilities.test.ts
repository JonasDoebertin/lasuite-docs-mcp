import { describe, expect, it, vi } from 'vitest';
import { probeCapabilities } from '../../src/api/capabilities.js';
import { DocsClient } from '../../src/api/client.js';
import { DocsApiError } from '../../src/api/errors.js';

function clientWhere(failing: Set<string>) {
  const client = new DocsClient(async () => new Response('{}', { status: 200 }));

  const reject = (action: string) =>
    Promise.reject(new DocsApiError('forbidden', 'nope', 403));

  vi.spyOn(client, 'listDocuments').mockImplementation(() =>
    failing.has('list') ? reject('list') : Promise.resolve([]),
  );
  vi.spyOn(client, 'searchDocuments').mockImplementation(() =>
    failing.has('search') ? reject('search') : Promise.resolve([]),
  );
  vi.spyOn(client, 'getTree').mockImplementation(() =>
    failing.has('tree')
      ? reject('tree')
      : Promise.resolve({ id: 'x', title: 'x', children: [] }),
  );
  vi.spyOn(client, 'getFormattedContent').mockImplementation(() =>
    failing.has('formatted_content') ? reject('formatted_content') : Promise.resolve(''),
  );

  return client;
}

// Every other test only needs "does this rejection disable the action", so
// `clientWhere` hardcodes a 403. These two cases need control over exactly
// which error the search probe rejects with, to pin the classification rule
// itself rather than just its 403 branch.
function clientWhereSearchRejectsWith(error: unknown) {
  const client = new DocsClient(async () => new Response('{}', { status: 200 }));

  vi.spyOn(client, 'listDocuments').mockResolvedValue([]);
  vi.spyOn(client, 'searchDocuments').mockRejectedValue(error);
  vi.spyOn(client, 'getTree').mockResolvedValue({ id: 'x', title: 'x', children: [] });
  vi.spyOn(client, 'getFormattedContent').mockResolvedValue('');

  return client;
}

describe('probeCapabilities', () => {
  it('marks every probed action enabled when all succeed', async () => {
    const capabilities = await probeCapabilities(clientWhere(new Set()));

    expect(capabilities.enabled.has('search')).toBe(true);
    expect(capabilities.enabled.has('tree')).toBe(true);
  });

  it('marks a probed action disabled when it is rejected', async () => {
    const capabilities = await probeCapabilities(clientWhere(new Set(['search'])));

    expect(capabilities.enabled.has('search')).toBe(false);
    expect(capabilities.probed.search).toBe(false);
  });

  it('assumes unprobeable write actions are available', async () => {
    const client = clientWhere(new Set(['search']));
    const capabilities = await probeCapabilities(client);

    expect(capabilities.enabled.has('content')).toBe(true);
    expect(capabilities.enabled.has('create')).toBe(true);
    expect(capabilities.probed.content).toBeUndefined();
    expect(client.isActionEnabled('content')).toBe(true);
  });

  it('assumes favorite_list is available, since Docs never gates it', async () => {
    const client = clientWhere(new Set());
    const capabilities = await probeCapabilities(client);

    expect(capabilities.enabled.has('favorite_list')).toBe(true);
    expect(client.isActionEnabled('favorite_list')).toBe(true);
  });

  it('treats a 404 on the placeholder document as the action working, not a 403', async () => {
    const capabilities = await probeCapabilities(
      clientWhereSearchRejectsWith(new DocsApiError('not_found', 'gone', 404)),
    );

    // If 404 were ever misread as failure, this would flip to false and
    // every read tool would disable itself on a correctly configured
    // instance -- the exact regression this test exists to catch.
    expect(capabilities.enabled.has('search')).toBe(true);
    expect(capabilities.probed.search).toBe(true);
  });

  it('treats an unrecognised, non-API exception as the action working, not disabled', async () => {
    const capabilities = await probeCapabilities(
      clientWhereSearchRejectsWith(new Error('boom')),
    );

    // Only a documented 403 may disable a tool. An unknown exception is the
    // most ambiguous signal there is, and disabling on it is the worse
    // failure mode: the tool just vanishes with nothing to search for,
    // instead of failing loudly and classifiably on first real use.
    expect(capabilities.enabled.has('search')).toBe(true);
    expect(capabilities.probed.search).toBe(true);
  });

  it('records the probe result on the client so 403s can be classified', async () => {
    const client = clientWhere(new Set(['search']));

    await probeCapabilities(client);

    expect(client.isActionEnabled('search')).toBe(false);
    expect(client.isActionEnabled('list')).toBe(true);
  });

  it('does not let one failing probe abort the others', async () => {
    const capabilities = await probeCapabilities(
      clientWhere(new Set(['list', 'tree'])),
    );

    expect(capabilities.enabled.has('search')).toBe(true);
    expect(capabilities.enabled.has('formatted_content')).toBe(true);
  });
});
