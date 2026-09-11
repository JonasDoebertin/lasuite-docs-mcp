import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthenticatedFetch } from '../../src/auth/client.js';
import { readCredentials, writeCredentials } from '../../src/auth/store.js';
import { DocsApiError } from '../../src/api/errors.js';

const config = {
  docsUrl: 'https://docs.example.org',
  issuerUrl: 'https://sso.example.org',
  clientId: 'client',
  scope: 'openid',
  profile: 'default',
};

const originalHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'docs-mcp-'));
});

afterEach(() => {
  process.env.HOME = originalHome;
  vi.unstubAllGlobals();
});

describe('createAuthenticatedFetch', () => {
  it('fails with an actionable error when no credentials are stored', async () => {
    const authed = createAuthenticatedFetch(config);

    await expect(authed('documents/')).rejects.toThrow(DocsApiError);
    await expect(authed('documents/')).rejects.toThrow(/lasuite-docs-mcp login/);
  });

  it('sends the bearer token against the external API base path', async () => {
    await writeCredentials('default', { accessToken: 'at', expiresAt: Date.now() + 60_000 });
    const spy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', spy);

    await createAuthenticatedFetch(config)('documents/');

    expect(spy.mock.calls[0]?.[0]).toBe(
      'https://docs.example.org/external_api/v1.0/documents/',
    );
    const headers = new Headers(spy.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer at');
  });

  it('refreshes an expired token before the request and persists the result', async () => {
    await writeCredentials('default', {
      accessToken: 'old',
      refreshToken: 'rt',
      expiresAt: Date.now() - 1_000,
    });

    const spy = vi.fn((url: string | URL) => {
      if (String(url).includes('.well-known')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ authorization_endpoint: 'a', token_endpoint: 'https://sso/t' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (String(url) === 'https://sso/t') {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'fresh', expires_in: 300 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', spy);

    await createAuthenticatedFetch(config)('documents/');

    expect((await readCredentials('default'))?.accessToken).toBe('fresh');
    const last = new Headers(spy.mock.calls.at(-1)?.[1]?.headers);
    expect(last.get('authorization')).toBe('Bearer fresh');
  });

  it('tells the user to log in again when the refresh token is rejected', async () => {
    await writeCredentials('default', {
      accessToken: 'old',
      refreshToken: 'bad',
      expiresAt: Date.now() - 1_000,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) =>
        Promise.resolve(
          String(url).includes('.well-known')
            ? new Response(
                JSON.stringify({ authorization_endpoint: 'a', token_endpoint: 'https://sso/t' }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              )
            : new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
        ),
      ),
    );

    await expect(createAuthenticatedFetch(config)('documents/')).rejects.toThrow(
      /lasuite-docs-mcp login/,
    );
  });
});
