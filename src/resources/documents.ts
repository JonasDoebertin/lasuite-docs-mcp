import type { DocsClient } from '../api/client.js';

const PREFIX = 'docs://document/';

// A resource list is sent to the client in full on every `resources/list`
// call -- there is no pagination in the MCP resource capability the way
// there is for `docs_list`. An account with hundreds of favorites would
// otherwise turn every session's resource listing into a multi-hundred-entry
// payload for a convenience feature. Past this many, only the first page the
// Docs API returns is exposed as resources; the rest remain reachable
// through docs_list and docs_read as before.
const MAX_FAVORITE_RESOURCES = 50;

export function documentUri(id: string): string {
  return `${PREFIX}${id}`;
}

export function parseDocumentUri(uri: string): string {
  if (!uri.startsWith(PREFIX)) {
    throw new Error(`Not a document URI. Expected docs://document/<id>, got "${uri}".`);
  }

  const id = uri.slice(PREFIX.length);
  if (id.length === 0) {
    throw new Error(`Missing document id. Expected docs://document/<id>, got "${uri}".`);
  }

  return id;
}

interface ResourceCapableServer {
  registerResource(
    name: string,
    uri: string,
    metadata: { title: string; description: string; mimeType: string },
    handler: (uri: URL) => Promise<{ contents: Array<{ uri: string; text: string }> }>,
  ): void;
}

export async function registerDocumentResources(
  server: ResourceCapableServer,
  client: DocsClient,
): Promise<void> {
  let favorites: Array<{ id: string; title: string }> = [];

  try {
    favorites = await client.listFavorites();
  } catch (error) {
    // Favorites are a convenience, not a required capability -- an instance
    // that denies or fails this lookup should not prevent the server from
    // starting. But a silent, empty resource list looks identical to "this
    // user has no favorites," which is a much harder thing to debug than a
    // one-line note. Stdout is reserved for MCP protocol frames, so stderr
    // is the only channel available; it is exactly where an operator running
    // the server manually, or Claude Code's own log capture, would look.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not list favorites; no document resources registered: ${message}\n`);
    return;
  }

  if (favorites.length > MAX_FAVORITE_RESOURCES) {
    process.stderr.write(
      `${favorites.length} favorites found; exposing only the first ` +
        `${MAX_FAVORITE_RESOURCES} as resources. The rest remain reachable via docs_list.\n`,
    );
  }

  for (const favorite of favorites.slice(0, MAX_FAVORITE_RESOURCES)) {
    server.registerResource(
      `favorite-${favorite.id}`,
      documentUri(favorite.id),
      {
        title: favorite.title,
        description: `Favorited Docs document: ${favorite.title}`,
        mimeType: 'text/markdown',
      },
      async (uri) => {
        const markdown = (await client.getFormattedContent(
          parseDocumentUri(uri.href),
          'markdown',
        )) as string;
        return { contents: [{ uri: uri.href, text: markdown }] };
      },
    );
  }
}
