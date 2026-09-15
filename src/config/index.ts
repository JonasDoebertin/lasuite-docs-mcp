import { z } from 'zod';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface Config {
  docsUrl: string;
  issuerUrl: string;
  clientId: string;
  scope: string;
  profile: string;
  // RFC 8707 resource indicator. Optional because it only matters when the
  // Docs instance and this client are separate registrations at the provider
  // and the token has to name Docs as an audience for it to be introspectable.
  resource?: string;
}

const httpUrl = z
  .string()
  .url()
  .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'must be an http(s) URL',
  });

const profileName = z
  .string()
  .min(1)
  .refine((value) => !value.includes('/') && !value.includes('\\') && !value.includes('..'), {
    message: 'must not contain path separators or ".." (it is used as a filename)',
  });

const schema = z.object({
  DOCS_URL: httpUrl,
  DOCS_OIDC_ISSUER: httpUrl,
  DOCS_OIDC_CLIENT_ID: z.string().min(1),
  DOCS_OIDC_SCOPE: z.string().min(1).default('openid'),
  DOCS_PROFILE: profileName.default('default'),
  DOCS_OIDC_RESOURCE: z.string().min(1).optional(),
});

// Validates and defaults DOCS_PROFILE alone, for commands (`logout`) that
// only need to know which credentials file to touch and must not force
// DOCS_URL / DOCS_OIDC_ISSUER / DOCS_OIDC_CLIENT_ID to be set just to run.
export function resolveProfile(env: NodeJS.ProcessEnv): string {
  const parsed = profileName.default('default').safeParse(env.DOCS_PROFILE);

  if (!parsed.success) {
    throw new ConfigError(
      `Invalid DOCS_PROFILE. ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }

  return parsed.data;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`Invalid configuration. ${details}`);
  }

  return {
    docsUrl: parsed.data.DOCS_URL.replace(/\/+$/, ''),
    issuerUrl: parsed.data.DOCS_OIDC_ISSUER.replace(/\/+$/, ''),
    clientId: parsed.data.DOCS_OIDC_CLIENT_ID,
    scope: parsed.data.DOCS_OIDC_SCOPE,
    profile: parsed.data.DOCS_PROFILE,
    resource: parsed.data.DOCS_OIDC_RESOURCE,
  };
}
