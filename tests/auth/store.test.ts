import { mkdtempSync, statSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from '../../src/auth/store.js';

let home: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'docs-mcp-'));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
});

describe('credential store', () => {
  it('returns null when no credentials have been written', async () => {
    expect(await readCredentials('default')).toBeNull();
  });

  it('round-trips credentials', async () => {
    const credentials = { accessToken: 'a', refreshToken: 'r', expiresAt: 123 };
    await writeCredentials('default', credentials);

    expect(await readCredentials('default')).toEqual(credentials);
  });

  it('writes the credentials file at mode 0600', async () => {
    await writeCredentials('default', { accessToken: 'a', expiresAt: 1 });
    const path = join(home, '.config', 'lasuite-docs-mcp', 'default.json');

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('re-tightens permissions on an existing credentials file with looser permissions', async () => {
    await writeCredentials('default', { accessToken: 'a', expiresAt: 1 });
    const path = join(home, '.config', 'lasuite-docs-mcp', 'default.json');
    await chmod(path, 0o644);

    await writeCredentials('default', { accessToken: 'b', expiresAt: 2 });

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps profiles separate', async () => {
    await writeCredentials('work', { accessToken: 'w', expiresAt: 1 });

    expect(await readCredentials('default')).toBeNull();
    expect((await readCredentials('work'))?.accessToken).toBe('w');
  });

  it('deletes credentials without failing when absent', async () => {
    await expect(deleteCredentials('default')).resolves.toBeUndefined();

    await writeCredentials('default', { accessToken: 'a', expiresAt: 1 });
    await deleteCredentials('default');

    expect(await readCredentials('default')).toBeNull();
  });

  it('returns null rather than throwing on a corrupt file', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(home, '.config', 'lasuite-docs-mcp'), { recursive: true });
    await writeFile(join(home, '.config', 'lasuite-docs-mcp', 'default.json'), 'not json');

    expect(await readCredentials('default')).toBeNull();
  });
});
