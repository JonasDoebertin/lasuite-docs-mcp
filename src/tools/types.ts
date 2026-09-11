/**
 * Structural type for the MCP server surface tool modules need. Depending on
 * this instead of `McpServer` directly keeps `src/tools/*` importable and
 * testable without constructing a real SDK server.
 */
export interface McpServerLike {
  registerTool(
    name: string,
    config: { description: string; inputSchema: unknown },
    handler: (params: any) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  ): void;
}
