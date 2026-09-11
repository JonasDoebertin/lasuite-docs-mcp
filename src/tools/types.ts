import type { z } from 'zod';

/**
 * Structural type for the MCP server surface tool modules need. Depending on
 * this instead of `McpServer` directly keeps `src/tools/*` importable and
 * testable without constructing a real SDK server.
 *
 * Generic over the input schema so the handler's parameter type is inferred
 * from `inputSchema` rather than widened to `any` — a handler whose
 * parameter type disagrees with its own schema is a compile error.
 */
export interface McpServerLike {
  registerTool<S extends z.ZodType>(
    name: string,
    config: { description: string; inputSchema: S },
    handler: (params: z.infer<S>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  ): void;
}
