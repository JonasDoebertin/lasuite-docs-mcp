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
});

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
  };
}
