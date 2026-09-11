import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { DocsClient } from './api/client.js';
import { probeCapabilities, type Capabilities } from './api/capabilities.js';
import { createAuthenticatedFetch } from './auth/client.js';
import { loadConfig } from './config/index.js';
import { registerListTool } from './tools/list.js';
import { registerReadTool } from './tools/read.js';
import { registerSearchTool } from './tools/search.js';
import { registerTreeTool } from './tools/tree.js';

export function createServer(client: DocsClient, capabilities: Capabilities): McpServer {
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
  if (capabilities.enabled.has('formatted_content')) {
    registerReadTool(server, client);
  }

  return server;
}

export async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const client = new DocsClient(createAuthenticatedFetch(config));
  const capabilities = await probeCapabilities(client);

  serveStdio(() => createServer(client, capabilities));
}
