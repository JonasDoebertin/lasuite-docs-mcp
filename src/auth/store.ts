import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

export interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

function configDir(): string {
  return join(process.env.HOME ?? homedir(), '.config', 'lasuite-docs-mcp');
}

export function credentialsPath(profile: string): string {
  return join(configDir(), `${profile}.json`);
}

export async function readCredentials(
  profile: string,
): Promise<StoredCredentials | null> {
  try {
    const raw = await readFile(credentialsPath(profile), 'utf8');
    const parsed = JSON.parse(raw) as StoredCredentials;
    return typeof parsed.accessToken === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeCredentials(
  profile: string,
  credentials: StoredCredentials,
): Promise<void> {
  const dir = configDir();
  // `mkdir`'s `mode` option only applies when the directory is created, so a
  // pre-existing directory with looser permissions would otherwise be left
  // as-is. This directory is exclusively ours, so it is safe to re-tighten
  // it unconditionally.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  const path = credentialsPath(profile);
  // Likewise, `writeFile`'s `mode` option only applies at file creation.
  // This file holds OAuth tokens and is rewritten on every refresh, so its
  // permissions must be enforced on every write, not just the first.
  await writeFile(path, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function deleteCredentials(profile: string): Promise<void> {
  await rm(credentialsPath(profile), { force: true });
}
