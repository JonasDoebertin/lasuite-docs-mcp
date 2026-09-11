import { describe, expect, it } from 'vitest';
import { DocsClient } from '../../src/api/client.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function queuedClient(responses: Array<() => Response>) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const delays: number[] = [];
  let index = 0;
  const client = new DocsClient(
    async (path, init) => {
      calls.push({ path, init });
      const next = responses[index];
      index += 1;
      if (!next) throw new Error('test setup error: ran out of queued responses');
      return next();
    },
    async (ms) => {
      delays.push(ms);
    },
  );
  return { client, calls, delays };
}

describe('DocsClient retries', () => {
  it('retries a GET once after a 500 and returns the eventual success', async () => {
    const { client, calls } = queuedClient([
      () => new Response('', { status: 500 }),
      () => json({ id: '1', title: 'A' }),
    ]);

    await expect(client.getDocument('1')).resolves.toMatchObject({ id: '1', title: 'A' });
    expect(calls).toHaveLength(2);
  });

  it('throws the final error once retry attempts are exhausted', async () => {
    const { client, calls } = queuedClient([
      () => new Response('', { status: 500 }),
      () => new Response('', { status: 500 }),
      () => new Response('', { status: 500 }),
    ]);

    await expect(client.getDocument('1')).rejects.toMatchObject({ kind: 'server' });
    expect(calls).toHaveLength(3);
  });

  it('does not retry a 400', async () => {
    const { client, calls } = queuedClient([() => new Response('', { status: 400 })]);

    await expect(client.getDocument('1')).rejects.toMatchObject({ kind: 'bad_request' });
    expect(calls).toHaveLength(1);
  });

  it('never retries a failing write', async () => {
    const { client, calls } = queuedClient([
      () => new Response('', { status: 500 }),
      () => json({ id: '2', title: 'B' }, 201),
    ]);

    await expect(client.createDocument('B')).rejects.toMatchObject({ kind: 'server' });
    expect(calls).toHaveLength(1);
  });

  it('honours Retry-After on a 429 before succeeding', async () => {
    const { client, calls, delays } = queuedClient([
      () => new Response('', { status: 429, headers: { 'retry-after': '2' } }),
      () => json({ id: '1', title: 'A' }),
    ]);

    await expect(client.getDocument('1')).resolves.toMatchObject({ id: '1' });
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([2000]);
  });

  it('caps an excessive Retry-After at 30 seconds', async () => {
    const { client, delays } = queuedClient([
      () => new Response('', { status: 429, headers: { 'retry-after': '9999' } }),
      () => json({ id: '1', title: 'A' }),
    ]);

    await client.getDocument('1');

    expect(delays).toEqual([30_000]);
  });

  it('falls back to normal backoff when Retry-After is absent or unparseable', async () => {
    const { client, delays } = queuedClient([
      () => new Response('', { status: 429, headers: { 'retry-after': 'not-a-number' } }),
      () => json({ id: '1', title: 'A' }),
    ]);

    await client.getDocument('1');

    expect(delays[0]).toBeGreaterThanOrEqual(250);
    expect(delays[0]).toBeLessThan(750);
  });

  it('retries a GET after a network failure', async () => {
    const calls: Array<{ path: string }> = [];
    let index = 0;
    const client = new DocsClient(
      async (path) => {
        calls.push({ path });
        index += 1;
        if (index === 1) throw new TypeError('fetch failed');
        return json({ id: '1', title: 'A' });
      },
      async () => {},
    );

    await expect(client.getDocument('1')).resolves.toMatchObject({ id: '1' });
    expect(calls).toHaveLength(2);
  });

  it('does not delay a non-retryable failure', async () => {
    const { client, delays } = queuedClient([() => new Response('', { status: 404 })]);

    await expect(client.getDocument('1')).rejects.toMatchObject({ kind: 'not_found' });
    expect(delays).toHaveLength(0);
  });
});
