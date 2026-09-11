// Mirrors the single value y-provider's env module supplies to the block specs.
// Only used to build absolute hrefs for interlinking links on export.
export const COLLABORATION_SERVER_ORIGIN =
  process.env.DOCS_URL ?? 'http://localhost:3000';
