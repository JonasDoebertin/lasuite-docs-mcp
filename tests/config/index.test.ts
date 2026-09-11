import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, resolveProfile } from '../../src/config/index.js';

const validEnv = {
  DOCS_URL: 'https://docs.example.org',
  DOCS_OIDC_ISSUER: 'https://sso.example.org/realms/main',
  DOCS_OIDC_CLIENT_ID: 'lasuite-docs-mcp',
};

describe('loadConfig', () => {
  it('reads the required variables', () => {
    const config = loadConfig({ ...validEnv });

    expect(config.docsUrl).toBe('https://docs.example.org');
    expect(config.issuerUrl).toBe('https://sso.example.org/realms/main');
    expect(config.clientId).toBe('lasuite-docs-mcp');
  });

  it('defaults the profile to "default"', () => {
    expect(loadConfig({ ...validEnv }).profile).toBe('default');
  });

  it('defaults the scope to openid', () => {
    expect(loadConfig({ ...validEnv }).scope).toBe('openid');
  });

  it('honours an explicit profile and scope', () => {
    const config = loadConfig({ ...validEnv, DOCS_PROFILE: 'work', DOCS_OIDC_SCOPE: 'openid email' });

    expect(config.profile).toBe('work');
    expect(config.scope).toBe('openid email');
  });

  it('strips a trailing slash from the instance URL', () => {
    expect(loadConfig({ ...validEnv, DOCS_URL: 'https://docs.example.org/' }).docsUrl).toBe(
      'https://docs.example.org',
    );
  });

  it('names the missing variable when one is absent', () => {
    expect(() => loadConfig({ ...validEnv, DOCS_URL: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv, DOCS_URL: undefined })).toThrow(/DOCS_URL/);
  });

  it('rejects an instance URL that is not http(s)', () => {
    expect(() => loadConfig({ ...validEnv, DOCS_URL: 'ftp://docs.example.org' })).toThrow(
      ConfigError,
    );
  });

  it('rejects a profile name containing path separators or ".."', () => {
    expect(() => loadConfig({ ...validEnv, DOCS_PROFILE: '../../.ssh/id_rsa' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...validEnv, DOCS_PROFILE: '../../.ssh/id_rsa' })).toThrow(
      /DOCS_PROFILE/,
    );
  });
});

describe('resolveProfile', () => {
  it('defaults to "default" with no other environment set', () => {
    expect(resolveProfile({})).toBe('default');
  });

  it('honours an explicit profile', () => {
    expect(resolveProfile({ DOCS_PROFILE: 'work' })).toBe('work');
  });

  it('rejects a profile name containing path separators or ".."', () => {
    expect(() => resolveProfile({ DOCS_PROFILE: '../../.ssh/id_rsa' })).toThrow(ConfigError);
  });
});
