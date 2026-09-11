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
    const capabilities = await probeCapabilities(clientWhere(new Set(['search'])));

    expect(capabilities.enabled.has('content')).toBe(true);
    expect(capabilities.enabled.has('create')).toBe(true);
    expect(capabilities.probed.content).toBeUndefined();
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
