import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';

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
  // `writeFile`'s `mode` option only takes effect when the file is created
  // (an existing inode ignores it), so overwriting the target directly would
  // briefly write the new token to a file that may still carry looser,
  // pre-existing permissions. Writing to a fresh, uniquely-named temp file in
  // the same directory means `mode: 0o600` is genuinely honoured at
  // creation, and a random suffix avoids collisions between concurrent
  // writers. Renaming the temp file over the target is atomic on POSIX
  // filesystems (both paths must be on the same filesystem, which the same
  // directory guarantees), so a reader never observes a partially written or
  // loosely permissioned file, and a crash mid-write leaves the previous
  // contents intact rather than truncated JSON.
  const tempPath = join(dir, `.${profile}.${randomBytes(8).toString('hex')}.tmp`);

  try {
    await writeFile(tempPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

export async function deleteCredentials(profile: string): Promise<void> {
  await rm(credentialsPath(profile), { force: true });
}
