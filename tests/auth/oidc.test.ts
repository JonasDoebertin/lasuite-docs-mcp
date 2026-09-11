import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverEndpoints,
  exchangeCode,
  refreshAccessToken,
} from '../../src/auth/oidc.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn((url: string | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init)),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('discoverEndpoints', () => {
  it('reads the endpoints from the well-known document', async () => {
    stubFetch(() =>
      json({
        authorization_endpoint: 'https://sso.example.org/auth',
        token_endpoint: 'https://sso.example.org/token',
      }),
    );

    await expect(discoverEndpoints('https://sso.example.org')).resolves.toEqual({
      authorizationEndpoint: 'https://sso.example.org/auth',
      tokenEndpoint: 'https://sso.example.org/token',
    });
  });

  it('requests the standard well-known path', async () => {
    const spy = stubFetch(() =>
      json({ authorization_endpoint: 'a', token_endpoint: 't' }),
    );

    await discoverEndpoints('https://sso.example.org');

    expect(spy.mock.calls[0]?.[0]).toBe(
      'https://sso.example.org/.well-known/openid-configuration',
    );
  });

  it('fails with a clear message when discovery is unreachable', async () => {
    stubFetch(() => new Response('nope', { status: 404 }));

    await expect(discoverEndpoints('https://sso.example.org')).rejects.toThrow(
      /OIDC discovery failed/,
    );
  });
});

describe('exchangeCode', () => {
  it('converts the token response into stored credentials', async () => {
    stubFetch(() =>
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 300 }),
    );
    const before = Date.now();

    const credentials = await exchangeCode({
      tokenEndpoint: 'https://sso.example.org/token',
      clientId: 'client',
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'http://127.0.0.1:1234/callback',
    });

    expect(credentials.accessToken).toBe('at');
    expect(credentials.refreshToken).toBe('rt');
    expect(credentials.expiresAt).toBeGreaterThanOrEqual(before + 300_000 - 1_000);
  });

  it('sends the PKCE verifier in the form body', async () => {
    const spy = stubFetch(() => json({ access_token: 'at', expires_in: 60 }));

    await exchangeCode({
      tokenEndpoint: 'https://sso.example.org/token',
      clientId: 'client',
      code: 'code',
      verifier: 'the-verifier',
      redirectUri: 'http://127.0.0.1:1234/callback',
    });

    expect(String(spy.mock.calls[0]?.[1]?.body)).toContain('code_verifier=the-verifier');
  });

  it('surfaces the provider error description', async () => {
    stubFetch(() => json({ error: 'invalid_grant', error_description: 'expired' }, 400));

    await expect(
      exchangeCode({
        tokenEndpoint: 'https://sso.example.org/token',
        clientId: 'client',
        code: 'code',
        verifier: 'v',
        redirectUri: 'http://127.0.0.1:1234/callback',
      }),
    ).rejects.toThrow(/expired/);
  });
});

describe('refreshAccessToken', () => {
  it('exchanges a refresh token for new credentials', async () => {
    stubFetch(() => json({ access_token: 'new', expires_in: 120 }));

    const credentials = await refreshAccessToken({
      tokenEndpoint: 'https://sso.example.org/token',
      clientId: 'client',
      refreshToken: 'rt',
    });

    expect(credentials.accessToken).toBe('new');
  });

  it('keeps the existing refresh token when the provider omits a new one', async () => {
    stubFetch(() => json({ access_token: 'new', expires_in: 120 }));

    const credentials = await refreshAccessToken({
      tokenEndpoint: 'https://sso.example.org/token',
      clientId: 'client',
      refreshToken: 'original',
    });

    expect(credentials.refreshToken).toBe('original');
  });
});
