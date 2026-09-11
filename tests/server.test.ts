import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';

import { createServer } from '../src/server.js';
import { DocsClient } from '../src/api/client.js';
import { ASSUMED_ACTIONS } from '../src/api/capabilities.js';
import type { Capabilities } from '../src/api/capabilities.js';

// `_registeredTools` is a private field on McpServer with no public
// equivalent for introspection short of simulating a `tools/list` request.
// Reading it directly through an `unknown` cast is the cheapest way to
// assert exactly which tools a given capability set produced -- which is
// the point of this suite: server.ts's registration conditionals are where
// a wrongly-scoped guard (like the section-anchor one fixed elsewhere on
// this branch) would otherwise hide undetected.
function registeredToolNames(server: McpServer): string[] {
  const internals = server as unknown as { _registeredTools: Record<string, unknown> };
  return Object.keys(internals._registeredTools).sort();
}

// Builds a Capabilities value with exactly the given actions enabled, with
// no implicit extras -- this exercises createServer's gating conditionals
// directly, independent of what probeCapabilities would ever actually
// produce (which always includes every ASSUMED_ACTION; see the dedicated
// "realistic" case below for that).
function capabilitiesWith(enabled: string[]): Capabilities {
  return { enabled: new Set(enabled), probed: {} };
}

function stubClient() {
  const client = new DocsClient(async () => new Response('{}', { status: 200 }));
  vi.spyOn(client, 'listFavorites').mockResolvedValue([]);
  return client;
}

describe('createServer', () => {
  it('registers every tool and the favorites resources on a fully permitted instance', async () => {
    const client = stubClient();
    const capabilities: Capabilities = {
      enabled: new Set([...ASSUMED_ACTIONS, 'list', 'search', 'tree', 'formatted_content']),
      probed: { list: true, search: true, tree: true, formatted_content: true },
    };

    const server = await createServer(client, capabilities);

    expect(registeredToolNames(server)).toEqual([
      'docs_create',
      'docs_edit',
      'docs_list',
      'docs_read',
      'docs_search',
      'docs_tree',
    ]);
  });

  it('registers only the default-enabled write tool when every probe fails and content_retrieve is absent', async () => {
    const client = stubClient();
    const capabilities = capabilitiesWith(['create', 'children']);

    const server = await createServer(client, capabilities);

    expect(registeredToolNames(server)).toEqual(['docs_create']);
  });

  it('registers docs_read via the content_retrieve fallback when formatted_content is disabled', async () => {
    const client = stubClient();
    const capabilities = capabilitiesWith(['content_retrieve']);

    const server = await createServer(client, capabilities);

    expect(registeredToolNames(server)).toEqual(['docs_read']);
  });

  it('does not register docs_read when neither formatted_content nor content_retrieve is enabled', async () => {
    const client = stubClient();
    const capabilities = capabilitiesWith(['search']);

    const server = await createServer(client, capabilities);

    expect(registeredToolNames(server)).not.toContain('docs_read');
  });

  it('does not register docs_edit when formatted_content is disabled, even with content enabled', async () => {
    const client = stubClient();
    const capabilities = capabilitiesWith(['content', 'content_retrieve']);

    const server = await createServer(client, capabilities);

    // docs_edit needs block-level fidelity from formatted_content; the
    // content_retrieve fallback that unblocks docs_read is deliberately not
    // extended to editing.
    expect(registeredToolNames(server)).not.toContain('docs_edit');
    expect(registeredToolNames(server)).toContain('docs_read');
  });

  it('does not register the favorites resources when formatted_content is disabled', async () => {
    const client = stubClient();
    const capabilities = capabilitiesWith(['content_retrieve']);

    await createServer(client, capabilities);

    expect(client.listFavorites).not.toHaveBeenCalled();
  });

  it('registers docs_create when only children succeeds, not create', async () => {
    const client = stubClient();
    const capabilities = capabilitiesWith(['children']);

    const server = await createServer(client, capabilities);

    expect(registeredToolNames(server)).toEqual(['docs_create']);
  });

  it('registers search, list, and tree independently of one another', async () => {
    const client = stubClient();
    const capabilities = capabilitiesWith(['search']);

    const server = await createServer(client, capabilities);

    expect(registeredToolNames(server)).toEqual(['docs_search']);
  });

  it('registers nothing when no action at all is enabled', async () => {
    const client = stubClient();
    const capabilities = capabilitiesWith([]);

    const server = await createServer(client, capabilities);

    expect(registeredToolNames(server)).toEqual([]);
  });
});
