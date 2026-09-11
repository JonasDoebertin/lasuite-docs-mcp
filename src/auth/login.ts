import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import type { Config } from '../config/index.js';
import { createPkcePair } from './pkce.js';
import { discoverEndpoints, exchangeCode } from './oidc.js';
import { writeCredentials } from './store.js';

interface PlatformOpenCommand {
  command: string;
  args: string[];
}

function getPlatformOpenCommand(url: string): PlatformOpenCommand {
  if (process.platform === 'darwin') {
    return { command: 'open', args: [url] };
  }

  if (process.platform === 'win32') {
    // `rundll32.exe` is a real executable (unlike `cmd.exe`'s `start`
    // builtin), so it spawns without a shell. That also sidesteps `start`
    // splitting the URL on `&`, which every OAuth authorize URL contains
    // between query parameters.
    return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }

  return { command: 'xdg-open', args: [url] };
}

function openBrowser(url: string): void {
  const { command, args } = getPlatformOpenCommand(url);
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });

  // Without this handler, a missing opener (no `xdg-open` on a headless
  // Linux box, or a spawn failure on Windows) would crash the whole login
  // command via Node's default handling of an unhandled `ChildProcess`
  // `'error'` event. The loopback server is already listening and the URL
  // is already printed, so the flow can continue with a manual open.
  child.on('error', () => {
    process.stderr.write(
      `Could not open a browser automatically. Open this URL manually:\n${url}\n`,
    );
  });

  child.unref();
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
    let settled = false;

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }

      const respond = (message: string) => {
        response.writeHead(200, { 'content-type': 'text/plain' }).end(message);
      };

      const stateParam = url.searchParams.get('state');
      const errorParam = url.searchParams.get('error');

      // A provider is required (RFC 6749 §4.1.2.1) to echo `state` even on
      // an error response. Only when `state` is missing entirely do we fall
      // back to reporting the provider's error directly; a *present but
      // wrong* state is always a state mismatch, never treated as this
      // branch, so a mismatched state can never masquerade as a provider
      // error to get the code accepted.
      if (stateParam === null && errorParam) {
        respond(`Login failed: ${errorParam}`);
        fail(new Error(`Login failed: ${errorParam}`));
        return;
      }

      if (stateParam !== state) {
        respond('Login failed: state mismatch.');
        fail(new Error('Login failed: OAuth state mismatch.'));
        return;
      }

      if (errorParam) {
        respond(`Login failed: ${errorParam}`);
        fail(new Error(`Login failed: ${errorParam}`));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        respond('Login failed: no authorization code.');
        fail(new Error('Login failed: no authorization code returned.'));
        return;
      }

      respond('Login complete. You can close this tab and return to the terminal.');
      succeed({ code, redirectUri });
    });

    // Centralised so that every rejection path closes the server. A bare
    // `reject` would leave a listening socket behind, keeping the event
    // loop alive and hanging the CLI even though the login promise settled.
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.close();
      reject(error);
    };

    const succeed = (result: CallbackResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.close();
      resolve(result);
    };

    server.on('error', fail);

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        fail(new Error('Could not bind the loopback callback server.'));
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
