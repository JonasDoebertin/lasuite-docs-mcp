import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

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
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(
    credentialsPath(profile),
    JSON.stringify(credentials, null, 2),
    { mode: 0o600 },
  );
}

export async function deleteCredentials(profile: string): Promise<void> {
  await rm(credentialsPath(profile), { force: true });
}
