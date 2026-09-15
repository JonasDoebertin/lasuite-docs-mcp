import type { StoredCredentials } from './store.js';

export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function discoverEndpoints(issuerUrl: string): Promise<OidcEndpoints> {
  const url = `${issuerUrl.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`OIDC discovery failed at ${url} (HTTP ${response.status}).`);
  }

  const document = (await response.json()) as {
    authorization_endpoint?: string;
    token_endpoint?: string;
  };

  if (!document.authorization_endpoint || !document.token_endpoint) {
    throw new Error(`OIDC discovery failed: ${url} omitted required endpoints.`);
  }

  return {
    authorizationEndpoint: document.authorization_endpoint,
    tokenEndpoint: document.token_endpoint,
  };
}

async function postToken(
  tokenEndpoint: string,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const payload = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok || !payload.access_token) {
    const reason = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
    throw new Error(`Token request failed: ${reason}`);
  }

  return payload;
}

function withResource(body: URLSearchParams, resource?: string): void {
  if (resource) {
    body.set('resource', resource);
  }
}

// client_secret_post rather than an Authorization header: both are listed by
// every provider that supports confidential clients at all, and keeping the
// credential in the form body keeps it out of proxy access logs that record
// request headers.
function withClientSecret(body: URLSearchParams, clientSecret?: string): void {
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }
}

function toCredentials(
  payload: TokenResponse,
  fallbackRefreshToken?: string,
): StoredCredentials {
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? fallbackRefreshToken,
    expiresAt: Date.now() + (payload.expires_in ?? 300) * 1000,
  };
}

export async function exchangeCode(params: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  resource?: string;
  clientSecret?: string;
}): Promise<StoredCredentials> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    code: params.code,
    code_verifier: params.verifier,
    redirect_uri: params.redirectUri,
  });
  withResource(body, params.resource);
  withClientSecret(body, params.clientSecret);

  return toCredentials(await postToken(params.tokenEndpoint, body));
}

export async function refreshAccessToken(params: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
  resource?: string;
  clientSecret?: string;
}): Promise<StoredCredentials> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: params.clientId,
    refresh_token: params.refreshToken,
  });
  // Carried through the refresh as well: a provider that scopes the audience
  // to the resources named in the request would otherwise hand back a token
  // the resource server can no longer introspect, turning a working session
  // into a mysterious 403 at the first refresh rather than at login.
  withResource(body, params.resource);
  withClientSecret(body, params.clientSecret);

  return toCredentials(await postToken(params.tokenEndpoint, body), params.refreshToken);
}
