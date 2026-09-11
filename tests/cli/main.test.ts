import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../src/cli.js';

const ENV_KEYS = ['DOCS_URL', 'DOCS_OIDC_ISSUER', 'DOCS_OIDC_CLIENT_ID', 'DOCS_PROFILE'] as const;
const originalEnv: Record<string, string | undefined> = {};
const originalHome = process.env.HOME;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.HOME = mkdtempSync(join(tmpdir(), 'docs-mcp-cli-'));
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  process.env.HOME = originalHome;
});

function captureStdout() {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string) => {
    chunks.push(chunk);
    return true;
  });
  return chunks;
}

describe('main', () => {
  it('prints usage for "help" with no environment configured', async () => {
    const chunks = captureStdout();

    const code = await main(['node', 'cli.js', 'help']);

    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/Usage: lasuite-docs-mcp/);
  });

  it('prints usage for no command at all, with no environment configured', async () => {
    const chunks = captureStdout();

    const code = await main(['node', 'cli.js']);

    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/Usage: lasuite-docs-mcp/);
  });

  it('exits 1 and prints usage for an unrecognised command', async () => {
    const chunks = captureStdout();

    const code = await main(['node', 'cli.js', 'bogus']);

    expect(code).toBe(1);
    expect(chunks.join('')).toMatch(/Usage: lasuite-docs-mcp/);
  });

  it('clears credentials for "logout" with no environment configured', async () => {
    const chunks = captureStdout();

    const code = await main(['node', 'cli.js', 'logout']);

    expect(code).toBe(0);
    expect(chunks.join('')).toMatch(/Cleared credentials for profile "default"/);
  });
});
