import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import type { Config } from '../config/index.js';
import { createPkcePair } from './pkce.js';
import { discoverEndpoints, exchangeCode } from './oidc.js';
import { writeCredentials } from './store.js';

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
}

interface CallbackResult {
  code: string;
  redirectUri: string;
}

function awaitCallback(
  config: Config,
  authorizationEndpoint: string,
  challenge: string,
  state: string,
): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    let redirectUri = '';

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }

      const finish = (message: string) => {
        response.writeHead(200, { 'content-type': 'text/plain' }).end(message);
        server.close();
      };

      if (url.searchParams.get('state') !== state) {
        finish('Login failed: state mismatch.');
        reject(new Error('Login failed: OAuth state mismatch.'));
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        finish(`Login failed: ${error}`);
        reject(new Error(`Login failed: ${error}`));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        finish('Login failed: no authorization code.');
        reject(new Error('Login failed: no authorization code returned.'));
        return;
      }

      finish('Login complete. You can close this tab and return to the terminal.');
      resolve({ code, redirectUri });
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not bind the loopback callback server.'));
        return;
      }

      redirectUri = `http://127.0.0.1:${address.port}/callback`;

      const authorizeUrl = new URL(authorizationEndpoint);
      authorizeUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: config.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();

      process.stderr.write(`Opening ${authorizeUrl.toString()}\n`);
      openBrowser(authorizeUrl.toString());
    });
  });
}

export async function runLogin(config: Config): Promise<void> {
  const endpoints = await discoverEndpoints(config.issuerUrl);
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(16).toString('base64url');

  const { code, redirectUri } = await awaitCallback(
    config,
    endpoints.authorizationEndpoint,
    challenge,
    state,
  );

  const credentials = await exchangeCode({
    tokenEndpoint: endpoints.tokenEndpoint,
    clientId: config.clientId,
    code,
    verifier,
    redirectUri,
  });

  await writeCredentials(config.profile, credentials);
  process.stderr.write(
    `Logged in. Credentials stored for profile "${config.profile}".\n`,
  );
}
