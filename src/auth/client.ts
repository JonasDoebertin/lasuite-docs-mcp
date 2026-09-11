import type { Config } from '../config/index.js';
import { DocsApiError } from '../api/errors.js';
import { discoverEndpoints, refreshAccessToken } from './oidc.js';
import { readCredentials, writeCredentials, type StoredCredentials } from './store.js';

export type AuthenticatedFetch = (path: string, init?: RequestInit) => Promise<Response>;

const LOGIN_HINT = 'Run `npx lasuite-docs-mcp login` and try again.';
const EXPIRY_SKEW_MS = 30_000;

async function currentCredentials(config: Config): Promise<StoredCredentials> {
  const stored = await readCredentials(config.profile);

  if (!stored) {
    throw new DocsApiError(
      'unauthenticated',
      `No stored credentials for profile "${config.profile}". ${LOGIN_HINT}`,
    );
  }

  if (stored.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return stored;
  }

  if (!stored.refreshToken) {
    throw new DocsApiError(
      'unauthenticated',
      `The stored access token has expired and there is no refresh token. ${LOGIN_HINT}`,
    );
  }

  try {
    const endpoints = await discoverEndpoints(config.issuerUrl);
    const refreshed = await refreshAccessToken({
      tokenEndpoint: endpoints.tokenEndpoint,
      clientId: config.clientId,
      refreshToken: stored.refreshToken,
    });
    await writeCredentials(config.profile, refreshed);
    return refreshed;
  } catch {
    throw new DocsApiError(
      'unauthenticated',
      `Could not refresh the stored session. ${LOGIN_HINT}`,
    );
  }
}

export function createAuthenticatedFetch(config: Config): AuthenticatedFetch {
  const base = `${config.docsUrl}/external_api/v1.0/`;

  return async (path, init = {}) => {
    const credentials = await currentCredentials(config);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${credentials.accessToken}`);

    // `path` is documented as relative to `base`, but `new URL(path, base)`
    // treats a leading slash as absolute and resolves it against the origin,
    // silently escaping the versioned `/external_api/v1.0/` prefix. Stripping
    // leading slashes keeps a caller's accidental `/documents/` pointed at
    // the same endpoint as the correct `documents/`, turning a would-be
    // wrong-endpoint request into a no-op difference.
    const relativePath = path.replace(/^\/+/, '');

    return fetch(new URL(relativePath, base).toString(), { ...init, headers });
  };
}
