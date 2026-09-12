#!/usr/bin/env node
import { DocsClient } from './api/client.js';
import {
  probeCapabilities,
  PROBED_ACTIONS,
  type Capabilities,
} from './api/capabilities.js';
import { createAuthenticatedFetch } from './auth/client.js';
import { runLogin } from './auth/login.js';
import { deleteCredentials, readCredentials } from './auth/store.js';
import { loadConfig, resolveProfile } from './config/index.js';

const REQUIRED_ACTIONS = [
  'list',
  'retrieve',
  'create',
  'children',
  'tree',
  'search',
  'content',
  'content_retrieve',
  'formatted_content',
  'can_edit',
];

const USAGE =
  'Usage: lasuite-docs-mcp <login|logout|status|doctor>\n\n' +
  'Environment: DOCS_URL, DOCS_OIDC_ISSUER, DOCS_OIDC_CLIENT_ID,\n' +
  'optional DOCS_OIDC_SCOPE and DOCS_PROFILE.\n';

export function renderDoctorReport(capabilities: Capabilities): string {
  const lines = ['Probed actions:'];

  for (const action of PROBED_ACTIONS) {
    lines.push(`  ${action}: ${capabilities.probed[action] ? 'available' : 'blocked'}`);
  }

  const blocked = PROBED_ACTIONS.filter((action) => !capabilities.probed[action]);

  if (blocked.length === 0) {
    lines.push('', 'All probed actions are available.');
    return lines.join('\n');
  }

  lines.push(
    '',
    `Blocked: ${blocked.join(', ')}.`,
    'Set this EXTERNAL_API value on the Docs instance and restart it:',
    '',
    JSON.stringify(
      { documents: { enabled: true, actions: REQUIRED_ACTIONS } },
      null,
      2,
    ),
  );

  return lines.join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[2] ?? 'help';

  switch (command) {
    case 'login': {
      const config = loadConfig(process.env);
      await runLogin(config);
      return 0;
    }

    case 'logout': {
      // deleteCredentials only needs the profile name, and loadConfig would
      // otherwise force DOCS_URL/DOCS_OIDC_ISSUER/DOCS_OIDC_CLIENT_ID to be
      // set just to clear a local file. resolveProfile validates and
      // defaults DOCS_PROFILE the same way loadConfig does, without
      // requiring the rest of the environment.
      const profile = resolveProfile(process.env);
      await deleteCredentials(profile);
      process.stdout.write(`Cleared credentials for profile "${profile}".\n`);
      return 0;
    }

    case 'status': {
      const config = loadConfig(process.env);
      const credentials = await readCredentials(config.profile);
      if (!credentials) {
        process.stdout.write(`Not logged in (profile "${config.profile}").\n`);
        return 1;
      }
      const expiry = new Date(credentials.expiresAt).toISOString();
      process.stdout.write(
        `Logged in to ${config.docsUrl} (profile "${config.profile}"), token expires ${expiry}.\n`,
      );
      return 0;
    }

    case 'doctor': {
      const config = loadConfig(process.env);
      const client = new DocsClient(createAuthenticatedFetch(config));
      process.stdout.write(`${renderDoctorReport(await probeCapabilities(client))}\n`);
      return 0;
    }

    default:
      process.stdout.write(USAGE);
      return command === 'help' ? 0 : 1;
  }
}

if (process.argv[1]?.endsWith('cli.js')) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((error: Error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}
