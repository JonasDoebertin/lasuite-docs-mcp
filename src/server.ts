import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { DocsClient } from './api/client.js';
import { probeCapabilities, type Capabilities } from './api/capabilities.js';
import { createAuthenticatedFetch } from './auth/client.js';
import { loadConfig } from './config/index.js';
import { registerDocumentResources } from './resources/documents.js';
import { registerCreateTool } from './tools/create.js';
import { registerEditTool } from './tools/edit.js';
import { registerListTool } from './tools/list.js';
import { registerReadTool } from './tools/read.js';
import { registerSearchTool } from './tools/search.js';
import { registerTreeTool } from './tools/tree.js';

export async function createServer(
  client: DocsClient,
  capabilities: Capabilities,
): Promise<McpServer> {
  const server = new McpServer({ name: 'lasuite-docs', version: '0.1.0' });

  if (capabilities.enabled.has('search')) {
    registerSearchTool(server, client);
  }
  if (capabilities.enabled.has('list')) {
    registerListTool(server, client);
  }
  if (capabilities.enabled.has('tree')) {
    registerTreeTool(server, client);
  }
  // docs_read prefers formatted_content but falls back to content_retrieve
  // plus local Yjs conversion when the instance doesn't expose the former,
  // so the tool only needs to go unregistered when neither read path works.
  if (capabilities.enabled.has('formatted_content') || capabilities.enabled.has('content_retrieve')) {
    registerReadTool(server, client);
  }
  // docs_create can route through either the root `create` action or the
  // `children` action when nesting under a parent -- an instance may permit
  // one without the other, so the tool stays registered if either works and
  // lets a rejected route surface its own classified error at call time.
  if (capabilities.enabled.has('create') || capabilities.enabled.has('children')) {
    registerCreateTool(server, client);
  }
  if (capabilities.enabled.has('content') && capabilities.enabled.has('formatted_content')) {
    registerEditTool(server, client);
  }
  if (capabilities.enabled.has('formatted_content')) {
    await registerDocumentResources(server, client);
  }

  return server;
}

export async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const client = new DocsClient(createAuthenticatedFetch(config));
  const capabilities = await probeCapabilities(client);

  const server = await createServer(client, capabilities);
  serveStdio(() => server);
}
