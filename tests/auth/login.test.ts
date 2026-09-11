import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { runLogin } from '../../src/auth/login.js';
import { readCredentials } from '../../src/auth/store.js';
import type { Config } from '../../src/config/index.js';

const config: Config = {
  docsUrl: 'https://docs.example.org',
  issuerUrl: 'https://idp.example.org',
  clientId: 'client-id',
  scope: 'openid',
  profile: 'login-flow-test',
};

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

function stubDiscoveryAndTokenEndpoint() {
  stubFetch((url) => {
    if (url.endsWith('/.well-known/openid-configuration')) {
      return json({
        authorization_endpoint: 'https://idp.example.org/auth',
        token_endpoint: 'https://idp.example.org/token',
      });
    }

    if (url === 'https://idp.example.org/token') {
      return json({ access_token: 'at', refresh_token: 'rt', expires_in: 300 });
    }

    return new Response('not found', { status: 404 });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function requestCallback(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    // `agent: false` forces a fresh connection per call instead of reusing a
    // pooled keep-alive socket. Reusing a socket from an earlier request
    // would let a second call succeed against a connection the server
    // opened before `close()`, masking whether the listening port was
    // actually released.
    httpGet(url, { agent: false }, (response) => {
      let body = '';
      response.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    }).on('error', reject);
  });
}

let home: string;
const originalHome = process.env.HOME;
let capturedBrowserUrl: string | null;
let capturedChild: EventEmitter | null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'docs-mcp-login-'));
  process.env.HOME = home;

  capturedBrowserUrl = null;
  capturedChild = null;

  vi.mocked(spawn).mockImplementation((_command, args) => {
    capturedBrowserUrl = ((args ?? []) as string[]).find((arg) => arg.startsWith('http')) ?? null;
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => {};
    capturedChild = child;
    return child as unknown as ChildProcess;
  });
});

afterEach(() => {
  process.env.HOME = originalHome;
  vi.unstubAllGlobals();
  vi.mocked(spawn).mockReset();
});

interface CapturedAuthorizeUrl {
  state: string;
  redirectUri: URL;
}

async function waitForAuthorizeUrl(): Promise<CapturedAuthorizeUrl> {
  await waitFor(() => capturedBrowserUrl !== null);
  if (!capturedBrowserUrl) {
    throw new Error('the authorize URL was never captured');
  }

  const authorizeUrl = new URL(capturedBrowserUrl);
  const state = authorizeUrl.searchParams.get('state');
  const redirectUriParam = authorizeUrl.searchParams.get('redirect_uri');
  if (!state || !redirectUriParam) {
    throw new Error('the captured authorize URL is missing state or redirect_uri');
  }

  return { state, redirectUri: new URL(redirectUriParam) };
}

describe('runLogin callback handling', () => {
  it('rejects with a state mismatch, and never the provider error, when a present state does not match', async () => {
    stubDiscoveryAndTokenEndpoint();
    const runLoginPromise = runLogin(config);
    // Prevent Node from flagging this as an unhandled rejection during the
    // window between the callback request landing and the `.rejects`
    // assertion below attaching its own handler.
    runLoginPromise.catch(() => {});

    const { redirectUri } = await waitForAuthorizeUrl();
    const response = await requestCallback(
      `http://127.0.0.1:${redirectUri.port}/callback?state=wrong-state&error=access_denied`,
    );

    expect(response.body).toContain('state mismatch');
    expect(response.body).not.toContain('access_denied');
    await expect(runLoginPromise).rejects.toThrow(/OAuth state mismatch/);
  });

  it("surfaces the provider's error when state is omitted from the callback entirely", async () => {
    stubDiscoveryAndTokenEndpoint();
    const runLoginPromise = runLogin(config);
    // Prevent Node from flagging this as an unhandled rejection during the
    // window between the callback request landing and the `.rejects`
    // assertion below attaching its own handler.
    runLoginPromise.catch(() => {});

    const { redirectUri } = await waitForAuthorizeUrl();
    const response = await requestCallback(
      `http://127.0.0.1:${redirectUri.port}/callback?error=access_denied`,
    );

    expect(response.body).toContain('access_denied');
    expect(response.body).not.toContain('state mismatch');
    await expect(runLoginPromise).rejects.toThrow(/access_denied/);
  });

  it('closes the loopback server after a failed callback, releasing the port', async () => {
    stubDiscoveryAndTokenEndpoint();
    const runLoginPromise = runLogin(config);
    // Prevent Node from flagging this as an unhandled rejection during the
    // window between the callback request landing and the `.rejects`
    // assertion below attaching its own handler.
    runLoginPromise.catch(() => {});

    const { redirectUri } = await waitForAuthorizeUrl();
    const port = redirectUri.port;

    await requestCallback(`http://127.0.0.1:${port}/callback?state=wrong-state`);
    await expect(runLoginPromise).rejects.toThrow();

    await expect(requestCallback(`http://127.0.0.1:${port}/callback`)).rejects.toThrow();
  });

  it('does not crash when the platform browser cannot be launched, and still completes login manually', async () => {
    stubDiscoveryAndTokenEndpoint();
    const runLoginPromise = runLogin(config);
    // Prevent Node from flagging this as an unhandled rejection during the
    // window between the callback request landing and the `.rejects`
    // assertion below attaching its own handler.
    runLoginPromise.catch(() => {});

    const { state, redirectUri } = await waitForAuthorizeUrl();
    if (!capturedChild) {
      throw new Error('spawn was not called');
    }

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    capturedChild.emit('error', new Error('ENOENT'));
    expect(
      stderrSpy.mock.calls.some(([chunk]) => String(chunk).includes('Open this URL manually')),
    ).toBe(true);
    stderrSpy.mockRestore();

    const response = await requestCallback(
      `http://127.0.0.1:${redirectUri.port}/callback?state=${state}&code=abc123`,
    );

    expect(response.body).toContain('Login complete');
    await expect(runLoginPromise).resolves.toBeUndefined();

    const stored = await readCredentials(config.profile);
    expect(stored?.accessToken).toBe('at');
  });
});
