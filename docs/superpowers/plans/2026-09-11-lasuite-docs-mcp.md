# LaSuite Docs MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an MCP server that lets Claude Code search, read, author, and edit documents on a LaSuite Docs instance.

**Architecture:** The server talks to Docs' OAuth2 resource server at `/external_api/v1.0/` and converts content in-process with the same `@blocknote/server-util` calls the instance's own y-provider uses, so it needs no privileged shared secret and stays portable. Editing splices BlockNote blocks rather than markdown text, preserving content markdown cannot express.

**Tech Stack:** TypeScript (ESM), Node >= 22, `@modelcontextprotocol/server` 2.0.0, `@blocknote/core` + `@blocknote/server-util` 0.54.0, `yjs`, `zod` v4, `vitest`.

**Spec:** `docs/superpowers/specs/2026-09-11-lasuite-docs-mcp-design.md`

## Global Constraints

- Upstream pin: all vendored code and contract expectations track Docs tag **`v5.6.1`**.
- `@blocknote/core` and `@blocknote/server-util` pinned to **exactly `0.54.0`** (no caret), matching upstream y-provider at `v5.6.1`. A mismatch risks silent document corruption.
- The Yjs XML fragment key is **`document-store`**. It appears in every `blocksToYDoc` / `yDocToBlocks` call.
- **Never send `websocket: true`** on `PATCH /documents/{id}/content/`. It bypasses the collaboration lock and overwrites live editing sessions.
- Package is ESM (`"type": "module"`), `engines.node >= 22`.
- Credentials file is written at mode **`0600`**.
- All code, comments, error messages, and commit messages in **English**.
- TDD throughout: write the failing test, run it, see it fail, then implement. Do not skip observing the red.

## Reference: upstream sources

Read these when a task references them. They are the ground truth this plan was derived from.

| What | Where |
|---|---|
| Conversion logic to replicate | `src/frontend/servers/y-provider/src/handlers/convertHandler.ts` |
| Block schema to vendor | `src/frontend/servers/y-provider/src/blockSpecs/` |
| Resource server gating | `src/backend/core/external_api/permissions.py` |
| Document endpoints | `src/backend/core/api/viewsets.py` |

Base URL: `https://raw.githubusercontent.com/suitenumerique/docs/v5.6.1/`

## Endpoint reference

All paths are relative to `{DOCS_URL}/external_api/v1.0/`.

| Purpose | Request | Notes |
|---|---|---|
| Current user | `GET users/me/` | Enabled by default upstream |
| List documents | `GET documents/` | `is_creator_me`, `is_favorite`, `title`, `ordering`, `page_size` |
| Search | `GET documents/search/?q=` | Degrades to title search without the Find indexer |
| Retrieve | `GET documents/{id}/` | |
| Tree | `GET documents/{id}/tree/` | Ancestors plus immediate children |
| Children | `GET documents/{id}/children/` | `POST` creates a child |
| Favorites | `GET documents/favorite_list/` | Always permitted, needs no allowlist entry |
| Formatted content | `GET documents/{id}/formatted-content/?content_format=json\|markdown\|html` | Returns `{id, title, content, created_at, updated_at}`; `content` is `null` for an empty document |
| Raw content + ETag | `GET documents/{id}/content/` | Body is base64 Yjs; `ETag` response header |
| Write content | `PATCH documents/{id}/content/` | Body `{"content": "<base64>"}`; returns 204 |
| Edit lock | `GET documents/{id}/can-edit/` | `{"can_edit": bool}` |
| Create | `POST documents/` | `{"title": "..."}`; create empty, then write content |

---

### Task 1: Project scaffold and vendored BlockNote schema

Sets up the package and pulls in the four Docs block specs. The vendoring is scripted rather than hand-copied so the drift canary can be mechanical.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `scripts/vendor-blockspecs.sh`
- Create: `src/content/blockSpecs/` (populated by the script)
- Create: `src/content/schema.ts`
- Test: `tests/content/schema.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `docsBlockNoteSchema` plus types `DocsBlockSchema`, `DocsInlineContentSchema`, `DocsStyleSchema` from `src/content/schema.ts`

- [ ] **Step 1: Create the package manifest**

```json
{
  "name": "lasuite-docs-mcp",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "bin": { "lasuite-docs-mcp": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:contract": "vitest run --config vitest.contract.config.ts",
    "vendor": "bash scripts/vendor-blockspecs.sh"
  },
  "dependencies": {
    "@blocknote/core": "0.54.0",
    "@blocknote/server-util": "0.54.0",
    "@modelcontextprotocol/server": "2.0.0",
    "yjs": "^13.6.32",
    "zod": "^4.2.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^4.0.0"
  }
}
```

Note the BlockNote versions carry no caret. That is deliberate; see Global Constraints.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

`DOM` is in `lib` because the vendored block specs call `document.createElement`. `ServerBlockNoteEditor` supplies the DOM at runtime; this only satisfies the type checker.

- [ ] **Step 3: Create `vitest.config.ts` and `.gitignore`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/contract/**'],
  },
});
```

```gitignore
node_modules/
dist/
*.log
```

- [ ] **Step 4: Write the vendoring script**

Create `scripts/vendor-blockspecs.sh`:

```bash
#!/usr/bin/env bash
# Vendors the Docs BlockNote block specs from upstream.
# The pinned ref must match the BlockNote version in package.json.
set -euo pipefail

REF="v5.6.1"
BASE="https://raw.githubusercontent.com/suitenumerique/docs/${REF}/src/frontend/servers/y-provider/src/blockSpecs"
DEST="$(dirname "$0")/../src/content/blockSpecs"

mkdir -p "$DEST"
for file in index Callout Pdf UploadLoader InterlinkingLinkInline; do
  curl -fsSL "${BASE}/${file}.ts" -o "${DEST}/${file}.ts"
  echo "vendored ${file}.ts"
done

# Upstream resolves './blockSpecs' through a path alias we do not use.
sed -i.bak "s|from '@/blockSpecs'|from './blockSpecs/index.js'|g" "${DEST}"/*.ts
rm -f "${DEST}"/*.bak

echo "vendored from ${REF}"
```

- [ ] **Step 5: Run the vendoring script**

```bash
npm install
chmod +x scripts/vendor-blockspecs.sh
npm run vendor
```

Expected: five files appear under `src/content/blockSpecs/`. Open `index.ts` and confirm it exports `docsBlockNoteSchema`.

- [ ] **Step 6: Write the failing drift canary test**

Create `tests/content/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { docsBlockNoteSchema } from '../../src/content/schema.js';

describe('vendored Docs schema', () => {
  it('registers the four Docs-specific specs on top of BlockNote defaults', () => {
    const blockTypes = Object.keys(docsBlockNoteSchema.blockSchema);
    expect(blockTypes).toContain('callout');
    expect(blockTypes).toContain('pdf');
    expect(blockTypes).toContain('uploadLoader');
    expect(blockTypes).toContain('pageBreak');
  });

  it('registers the interlinking inline content spec', () => {
    const inlineTypes = Object.keys(docsBlockNoteSchema.inlineContentSchema);
    expect(inlineTypes).toContain('interlinkingLinkInline');
  });

  it('still provides the default block types the editor relies on', () => {
    const blockTypes = Object.keys(docsBlockNoteSchema.blockSchema);
    expect(blockTypes).toContain('paragraph');
    expect(blockTypes).toContain('heading');
    expect(blockTypes).toContain('bulletListItem');
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

```bash
npx vitest run tests/content/schema.test.ts
```

Expected: FAIL, cannot resolve `../../src/content/schema.js`.

- [ ] **Step 8: Create the schema re-export**

Create `src/content/schema.ts`:

```ts
export {
  docsBlockNoteSchema,
  type DocsBlockSchema,
  type DocsInlineContentSchema,
  type DocsStyleSchema,
} from './blockSpecs/index.js';
```

- [ ] **Step 9: Run the test to verify it passes**

```bash
npx vitest run tests/content/schema.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore scripts/ src/content/ tests/content/
git commit -m "Add project scaffold and vendor the Docs block schema"
```

---

### Task 2: Content conversion

The riskiest part of the architecture, built second so it is proven before anything depends on it. This replicates `convertHandler.ts` exactly, including the comments extension, which upstream documents as load-bearing: without it, y-prosemirror silently drops every commented run of text.

**Files:**
- Create: `src/content/types.ts`
- Create: `src/content/editor.ts`
- Create: `src/content/convert.ts`
- Test: `tests/content/convert.test.ts`

**Interfaces:**
- Consumes: `docsBlockNoteSchema` and its types from Task 1
- Produces:
  - `type DocsBlock` (from `src/content/types.ts`)
  - `markdownToBlocks(markdown: string): Promise<DocsBlock[]>`
  - `blocksToMarkdown(blocks: DocsBlock[]): Promise<string>`
  - `blocksToYjsBase64(blocks: DocsBlock[]): string`
  - `yjsBase64ToBlocks(base64: string): DocsBlock[]`

- [ ] **Step 1: Write the failing round-trip test**

Create `tests/content/convert.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  blocksToMarkdown,
  blocksToYjsBase64,
  markdownToBlocks,
  yjsBase64ToBlocks,
} from '../../src/content/convert.js';

describe('content conversion', () => {
  it('round-trips markdown through Yjs without losing text', async () => {
    const markdown = '# Title\n\nA paragraph with **bold** text.\n\n## Section\n\n- one\n- two';

    const blocks = await markdownToBlocks(markdown);
    const base64 = blocksToYjsBase64(blocks);
    const restored = yjsBase64ToBlocks(base64);
    const output = await blocksToMarkdown(restored);

    expect(output).toContain('# Title');
    expect(output).toContain('**bold**');
    expect(output).toContain('## Section');
    expect(output).toContain('one');
    expect(output).toContain('two');
  });

  it('produces base64 that decodes to a non-empty Yjs update', async () => {
    const blocks = await markdownToBlocks('hello');
    const base64 = blocksToYjsBase64(blocks);

    expect(base64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(base64, 'base64').byteLength).toBeGreaterThan(0);
  });

  it('preserves a custom callout block across a Yjs round trip', async () => {
    const blocks = [
      { type: 'callout' as const, props: { emoji: '💡' }, content: 'Watch out' },
      { type: 'paragraph' as const, content: 'after' },
    ];

    const restored = yjsBase64ToBlocks(blocksToYjsBase64(blocks as never));
    const types = restored.map((block) => block.type);

    expect(types).toContain('callout');
    expect(types).toContain('paragraph');
  });

  it('treats an empty block list as a valid empty document', () => {
    const base64 = blocksToYjsBase64([]);
    expect(yjsBase64ToBlocks(base64)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/content/convert.test.ts
```

Expected: FAIL, cannot resolve `src/content/convert.js`.

- [ ] **Step 3: Define the block type alias**

Create `src/content/types.ts`:

```ts
import type { PartialBlock } from '@blocknote/core';
import type {
  DocsBlockSchema,
  DocsInlineContentSchema,
  DocsStyleSchema,
} from './schema.js';

export type DocsBlock = PartialBlock<
  DocsBlockSchema,
  DocsInlineContentSchema,
  DocsStyleSchema
>;
```

- [ ] **Step 4: Create the shared editor instance**

Create `src/content/editor.ts`. This mirrors `convertHandler.ts`; keep the comment, it explains a non-obvious failure mode.

```ts
import { CommentsExtension, DefaultThreadStoreAuth } from '@blocknote/core/comments';
import { YjsThreadStore } from '@blocknote/core/yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import * as Y from 'yjs';

import {
  docsBlockNoteSchema,
  type DocsBlockSchema,
  type DocsInlineContentSchema,
  type DocsStyleSchema,
} from './schema.js';

export const YJS_FRAGMENT_KEY = 'document-store';

// The "comment" mark must exist in the editor schema. A mark with no matching
// type is dropped by y-prosemirror together with the text it wraps, which would
// empty out every commented block on read. Registering CommentsExtension is the
// only supported way to add it. The thread store is never exercised during
// conversion; it exists to satisfy the extension's constructor.
const commentsThreadStore = new YjsThreadStore(
  'lasuite-docs-mcp',
  new Y.Doc().getMap('comment-threads'),
  new DefaultThreadStoreAuth('lasuite-docs-mcp', 'editor'),
);

export const editor = ServerBlockNoteEditor.create<
  DocsBlockSchema,
  DocsInlineContentSchema,
  DocsStyleSchema
>({
  schema: docsBlockNoteSchema,
  extensions: [
    CommentsExtension({
      threadStore: commentsThreadStore,
      resolveUsers: (userIds) =>
        Promise.resolve(userIds.map((id) => ({ id, username: id, avatarUrl: '' }))),
    }),
  ],
});
```

- [ ] **Step 5: Implement the conversion functions**

Create `src/content/convert.ts`:

```ts
import * as Y from 'yjs';

import { editor, YJS_FRAGMENT_KEY } from './editor.js';
import type { DocsBlock } from './types.js';

export async function markdownToBlocks(markdown: string): Promise<DocsBlock[]> {
  return editor.tryParseMarkdownToBlocks(markdown);
}

export async function blocksToMarkdown(blocks: DocsBlock[]): Promise<string> {
  return editor.blocksToMarkdownLossy(blocks);
}

export function blocksToYjsBase64(blocks: DocsBlock[]): string {
  const ydoc = editor.blocksToYDoc(blocks, YJS_FRAGMENT_KEY);
  try {
    return Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64');
  } finally {
    ydoc.destroy();
  }
}

export function yjsBase64ToBlocks(base64: string): DocsBlock[] {
  const ydoc = new Y.Doc();
  try {
    Y.applyUpdate(ydoc, new Uint8Array(Buffer.from(base64, 'base64')));
    return editor.yDocToBlocks(ydoc, YJS_FRAGMENT_KEY);
  } finally {
    ydoc.destroy();
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
npx vitest run tests/content/convert.test.ts
```

Expected: PASS, 4 tests. If the callout test fails, the vendored schema did not load; re-run `npm run vendor` before debugging anything else.

- [ ] **Step 7: Commit**

```bash
git add src/content/ tests/content/
git commit -m "Add markdown, block, and Yjs conversion"
```

---

### Task 3: Heading index and anchor resolution

Gives `docs_read` and `docs_edit` a shared, legible way to name a section.

**Files:**
- Create: `src/content/headings.ts`
- Test: `tests/content/headings.test.ts`

**Interfaces:**
- Consumes: `DocsBlock` from Task 2
- Produces:
  - `interface HeadingEntry { anchor: string; text: string; level: number; startIndex: number; endIndex: number }`
  - `indexHeadings(blocks: DocsBlock[]): HeadingEntry[]`
  - `resolveAnchor(entries: HeadingEntry[], anchor: string): HeadingEntry`
  - `class AnchorNotFoundError extends Error`
  - `blockText(block: DocsBlock): string`

`startIndex` is the index of the heading block itself. `endIndex` is exclusive and runs to the next heading of equal or higher level, or to the end of the document.

- [ ] **Step 1: Write the failing test**

Create `tests/content/headings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AnchorNotFoundError,
  indexHeadings,
  resolveAnchor,
} from '../../src/content/headings.js';
import type { DocsBlock } from '../../src/content/types.js';

const heading = (level: number, text: string): DocsBlock =>
  ({ type: 'heading', props: { level }, content: text }) as never;

const para = (text: string): DocsBlock =>
  ({ type: 'paragraph', content: text }) as never;

describe('indexHeadings', () => {
  it('returns an empty index for a document with no headings', () => {
    expect(indexHeadings([para('a'), para('b')])).toEqual([]);
  });

  it('ends a section at the next heading of equal level', () => {
    const blocks = [heading(2, 'One'), para('x'), heading(2, 'Two'), para('y')];
    const [first, second] = indexHeadings(blocks);

    expect(first).toMatchObject({ anchor: 'One', startIndex: 0, endIndex: 2 });
    expect(second).toMatchObject({ anchor: 'Two', startIndex: 2, endIndex: 4 });
  });

  it('includes nested lower-level headings inside the parent section', () => {
    const blocks = [heading(1, 'Top'), heading(2, 'Nested'), para('x'), heading(1, 'Next')];
    const [top] = indexHeadings(blocks);

    expect(top).toMatchObject({ anchor: 'Top', startIndex: 0, endIndex: 3 });
  });

  it('runs the final section to the end of the document', () => {
    const blocks = [para('intro'), heading(2, 'Last'), para('x'), para('y')];
    const [last] = indexHeadings(blocks);

    expect(last).toMatchObject({ startIndex: 1, endIndex: 4 });
  });

  it('disambiguates repeated heading text with a #n suffix', () => {
    const blocks = [heading(2, 'Setup'), para('x'), heading(2, 'Setup'), para('y')];
    const anchors = indexHeadings(blocks).map((entry) => entry.anchor);

    expect(anchors).toEqual(['Setup', 'Setup#2']);
  });
});

describe('resolveAnchor', () => {
  it('finds an entry by its anchor', () => {
    const entries = indexHeadings([heading(2, 'Setup'), para('x')]);
    expect(resolveAnchor(entries, 'Setup').startIndex).toBe(0);
  });

  it('throws AnchorNotFoundError listing the available anchors', () => {
    const entries = indexHeadings([heading(2, 'Setup'), heading(2, 'Usage')]);

    expect(() => resolveAnchor(entries, 'Missing')).toThrow(AnchorNotFoundError);
    expect(() => resolveAnchor(entries, 'Missing')).toThrow(/Setup, Usage/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/content/headings.test.ts
```

Expected: FAIL, cannot resolve `src/content/headings.js`.

- [ ] **Step 3: Implement the heading index**

Create `src/content/headings.ts`:

```ts
import type { DocsBlock } from './types.js';

export interface HeadingEntry {
  anchor: string;
  text: string;
  level: number;
  startIndex: number;
  endIndex: number;
}

export class AnchorNotFoundError extends Error {
  constructor(anchor: string, available: string[]) {
    const known = available.length > 0 ? available.join(', ') : 'none';
    super(`No heading matches "${anchor}". Available anchors: ${known}`);
    this.name = 'AnchorNotFoundError';
  }
}

export function blockText(block: DocsBlock): string {
  const content = (block as { content?: unknown }).content;

  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map((part) => (typeof part === 'string' ? part : ((part as { text?: string }).text ?? '')))
    .join('');
}

function headingLevel(block: DocsBlock): number | null {
  if (block.type !== 'heading') {
    return null;
  }
  const level = (block.props as { level?: number } | undefined)?.level;
  return typeof level === 'number' ? level : 1;
}

export function indexHeadings(blocks: DocsBlock[]): HeadingEntry[] {
  const entries: HeadingEntry[] = [];
  const seen = new Map<string, number>();

  blocks.forEach((block, index) => {
    const level = headingLevel(block);
    if (level === null) {
      return;
    }

    const text = blockText(block);
    const occurrence = (seen.get(text) ?? 0) + 1;
    seen.set(text, occurrence);

    entries.push({
      anchor: occurrence === 1 ? text : `${text}#${occurrence}`,
      text,
      level,
      startIndex: index,
      endIndex: blocks.length,
    });
  });

  entries.forEach((entry, position) => {
    const next = entries
      .slice(position + 1)
      .find((candidate) => candidate.level <= entry.level);
    entry.endIndex = next ? next.startIndex : blocks.length;
  });

  return entries;
}

export function resolveAnchor(entries: HeadingEntry[], anchor: string): HeadingEntry {
  const match = entries.find((entry) => entry.anchor === anchor);
  if (!match) {
    throw new AnchorNotFoundError(anchor, entries.map((entry) => entry.anchor));
  }
  return match;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/content/headings.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/content/headings.ts tests/content/headings.test.ts
git commit -m "Add heading index and anchor resolution"
```

---

### Task 4: Block splicing and lossiness detection

The two pure functions that make block-space editing work. Splicing decides what the new document is; lossiness detection decides what the user must be told.

**Files:**
- Create: `src/content/lossy.ts`
- Create: `src/content/splice.ts`
- Test: `tests/content/lossy.test.ts`
- Test: `tests/content/splice.test.ts`

**Interfaces:**
- Consumes: `DocsBlock` (Task 2), `indexHeadings` / `resolveAnchor` (Task 3)
- Produces:
  - `interface LossyFinding { type: string; count: number }`
  - `detectLossyBlocks(blocks: DocsBlock[]): LossyFinding[]`
  - `type SpliceOperation = 'replace' | 'append' | 'prepend' | 'replace_section' | 'insert_after_section'`
  - `interface SpliceResult { blocks: DocsBlock[]; discarded: DocsBlock[] }`
  - `spliceBlocks(existing: DocsBlock[], incoming: DocsBlock[], operation: SpliceOperation, anchor?: string): SpliceResult`

- [ ] **Step 1: Write the failing lossiness test**

Create `tests/content/lossy.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detectLossyBlocks } from '../../src/content/lossy.js';
import type { DocsBlock } from '../../src/content/types.js';

const block = (type: string): DocsBlock => ({ type, content: '' }) as never;

describe('detectLossyBlocks', () => {
  it('reports nothing for blocks markdown can represent', () => {
    expect(detectLossyBlocks([block('paragraph'), block('heading')])).toEqual([]);
  });

  it('reports each Docs-specific block type that markdown cannot express', () => {
    const findings = detectLossyBlocks([block('callout'), block('pdf'), block('paragraph')]);

    expect(findings).toEqual(
      expect.arrayContaining([
        { type: 'callout', count: 1 },
        { type: 'pdf', count: 1 },
      ]),
    );
    expect(findings).toHaveLength(2);
  });

  it('counts repeated lossy blocks of the same type', () => {
    expect(detectLossyBlocks([block('callout'), block('callout')])).toEqual([
      { type: 'callout', count: 2 },
    ]);
  });

  it('reports page breaks and upload loaders', () => {
    const types = detectLossyBlocks([block('pageBreak'), block('uploadLoader')]).map((f) => f.type);
    expect(types).toEqual(expect.arrayContaining(['pageBreak', 'uploadLoader']));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/content/lossy.test.ts
```

Expected: FAIL, cannot resolve `src/content/lossy.js`.

- [ ] **Step 3: Implement lossiness detection**

Create `src/content/lossy.ts`:

```ts
import type { DocsBlock } from './types.js';

// Block types with no markdown representation. Round-tripping a document
// through markdown silently destroys these, which is why edits splice blocks.
const NON_REPRESENTABLE_TYPES = new Set([
  'callout',
  'pdf',
  'uploadLoader',
  'pageBreak',
]);

export interface LossyFinding {
  type: string;
  count: number;
}

export function detectLossyBlocks(blocks: DocsBlock[]): LossyFinding[] {
  const counts = new Map<string, number>();

  for (const block of blocks) {
    const type = block.type;
    if (typeof type === 'string' && NON_REPRESENTABLE_TYPES.has(type)) {
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }

  return [...counts.entries()].map(([type, count]) => ({ type, count }));
}
```

- [ ] **Step 4: Write the failing splice test**

Create `tests/content/splice.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { spliceBlocks } from '../../src/content/splice.js';
import { AnchorNotFoundError } from '../../src/content/headings.js';
import type { DocsBlock } from '../../src/content/types.js';

const heading = (level: number, text: string): DocsBlock =>
  ({ type: 'heading', props: { level }, content: text }) as never;

const para = (text: string): DocsBlock =>
  ({ type: 'paragraph', content: text }) as never;

const texts = (blocks: DocsBlock[]) =>
  blocks.map((block) => (block as { content?: string }).content);

describe('spliceBlocks', () => {
  const doc = [heading(2, 'One'), para('a'), heading(2, 'Two'), para('b')];

  it('replace discards the whole document', () => {
    const result = spliceBlocks(doc, [para('new')], 'replace');

    expect(texts(result.blocks)).toEqual(['new']);
    expect(result.discarded).toHaveLength(4);
  });

  it('append adds to the end and discards nothing', () => {
    const result = spliceBlocks(doc, [para('new')], 'append');

    expect(texts(result.blocks)).toEqual(['One', 'a', 'Two', 'b', 'new']);
    expect(result.discarded).toEqual([]);
  });

  it('prepend adds to the start and discards nothing', () => {
    const result = spliceBlocks(doc, [para('new')], 'prepend');

    expect(texts(result.blocks)).toEqual(['new', 'One', 'a', 'Two', 'b']);
    expect(result.discarded).toEqual([]);
  });

  it('replace_section swaps only the targeted section', () => {
    const result = spliceBlocks(doc, [para('new')], 'replace_section', 'One');

    expect(texts(result.blocks)).toEqual(['new', 'Two', 'b']);
    expect(texts(result.discarded)).toEqual(['One', 'a']);
  });

  it('insert_after_section keeps the section and inserts behind it', () => {
    const result = spliceBlocks(doc, [para('new')], 'insert_after_section', 'One');

    expect(texts(result.blocks)).toEqual(['One', 'a', 'new', 'Two', 'b']);
    expect(result.discarded).toEqual([]);
  });

  it('leaves blocks outside the edited section untouched by identity', () => {
    const result = spliceBlocks(doc, [para('new')], 'replace_section', 'One');

    expect(result.blocks[1]).toBe(doc[2]);
    expect(result.blocks[2]).toBe(doc[3]);
  });

  it('rejects a section operation with no anchor', () => {
    expect(() => spliceBlocks(doc, [para('x')], 'replace_section')).toThrow(
      /requires a section anchor/,
    );
  });

  it('rejects an anchor that does not exist', () => {
    expect(() => spliceBlocks(doc, [para('x')], 'replace_section', 'Nope')).toThrow(
      AnchorNotFoundError,
    );
  });

  it('appends into an empty document', () => {
    expect(texts(spliceBlocks([], [para('new')], 'append').blocks)).toEqual(['new']);
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

```bash
npx vitest run tests/content/splice.test.ts
```

Expected: FAIL, cannot resolve `src/content/splice.js`.

- [ ] **Step 6: Implement splicing**

Create `src/content/splice.ts`:

```ts
import { indexHeadings, resolveAnchor } from './headings.js';
import type { DocsBlock } from './types.js';

export type SpliceOperation =
  | 'replace'
  | 'append'
  | 'prepend'
  | 'replace_section'
  | 'insert_after_section';

export interface SpliceResult {
  blocks: DocsBlock[];
  discarded: DocsBlock[];
}

const SECTION_OPERATIONS = new Set<SpliceOperation>([
  'replace_section',
  'insert_after_section',
]);

export function spliceBlocks(
  existing: DocsBlock[],
  incoming: DocsBlock[],
  operation: SpliceOperation,
  anchor?: string,
): SpliceResult {
  if (SECTION_OPERATIONS.has(operation)) {
    if (!anchor) {
      throw new Error(`Operation "${operation}" requires a section anchor.`);
    }

    const entry = resolveAnchor(indexHeadings(existing), anchor);
    const before = existing.slice(0, entry.startIndex);
    const section = existing.slice(entry.startIndex, entry.endIndex);
    const after = existing.slice(entry.endIndex);

    if (operation === 'replace_section') {
      return { blocks: [...before, ...incoming, ...after], discarded: section };
    }
    return { blocks: [...before, ...section, ...incoming, ...after], discarded: [] };
  }

  switch (operation) {
    case 'replace':
      return { blocks: [...incoming], discarded: [...existing] };
    case 'append':
      return { blocks: [...existing, ...incoming], discarded: [] };
    case 'prepend':
      return { blocks: [...incoming, ...existing], discarded: [] };
  }
}
```

- [ ] **Step 7: Run both test files to verify they pass**

```bash
npx vitest run tests/content/
```

Expected: PASS, all content tests green.

- [ ] **Step 8: Commit**

```bash
git add src/content/ tests/content/
git commit -m "Add block splicing and lossiness detection"
```

---

### Task 5: Configuration and credential storage

**Files:**
- Create: `src/config/index.ts`
- Create: `src/auth/store.ts`
- Test: `tests/config/index.test.ts`
- Test: `tests/auth/store.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `interface Config { docsUrl: string; issuerUrl: string; clientId: string; scope: string; profile: string }`
  - `loadConfig(env: NodeJS.ProcessEnv): Config` (throws `ConfigError` with the missing variable named)
  - `class ConfigError extends Error`
  - `interface StoredCredentials { accessToken: string; refreshToken?: string; expiresAt: number }`
  - `credentialsPath(profile: string): string`
  - `readCredentials(profile: string): Promise<StoredCredentials | null>`
  - `writeCredentials(profile: string, credentials: StoredCredentials): Promise<void>`
  - `deleteCredentials(profile: string): Promise<void>`

`expiresAt` is epoch milliseconds.

- [ ] **Step 1: Write the failing config test**

Create `tests/config/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/index.js';

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
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/config/index.test.ts
```

Expected: FAIL, cannot resolve `src/config/index.js`.

- [ ] **Step 3: Implement config loading**

Create `src/config/index.ts`:

```ts
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

const schema = z.object({
  DOCS_URL: httpUrl,
  DOCS_OIDC_ISSUER: httpUrl,
  DOCS_OIDC_CLIENT_ID: z.string().min(1),
  DOCS_OIDC_SCOPE: z.string().min(1).default('openid'),
  DOCS_PROFILE: z.string().min(1).default('default'),
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/config/index.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing credential store test**

Create `tests/auth/store.test.ts`:

```ts
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteCredentials,
  readCredentials,
  writeCredentials,
} from '../../src/auth/store.js';

let home: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'docs-mcp-'));
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = originalHome;
});

describe('credential store', () => {
  it('returns null when no credentials have been written', async () => {
    expect(await readCredentials('default')).toBeNull();
  });

  it('round-trips credentials', async () => {
    const credentials = { accessToken: 'a', refreshToken: 'r', expiresAt: 123 };
    await writeCredentials('default', credentials);

    expect(await readCredentials('default')).toEqual(credentials);
  });

  it('writes the credentials file at mode 0600', async () => {
    await writeCredentials('default', { accessToken: 'a', expiresAt: 1 });
    const path = join(home, '.config', 'lasuite-docs-mcp', 'default.json');

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps profiles separate', async () => {
    await writeCredentials('work', { accessToken: 'w', expiresAt: 1 });

    expect(await readCredentials('default')).toBeNull();
    expect((await readCredentials('work'))?.accessToken).toBe('w');
  });

  it('deletes credentials without failing when absent', async () => {
    await expect(deleteCredentials('default')).resolves.toBeUndefined();

    await writeCredentials('default', { accessToken: 'a', expiresAt: 1 });
    await deleteCredentials('default');

    expect(await readCredentials('default')).toBeNull();
  });

  it('returns null rather than throwing on a corrupt file', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(home, '.config', 'lasuite-docs-mcp'), { recursive: true });
    await writeFile(join(home, '.config', 'lasuite-docs-mcp', 'default.json'), 'not json');

    expect(await readCredentials('default')).toBeNull();
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
npx vitest run tests/auth/store.test.ts
```

Expected: FAIL, cannot resolve `src/auth/store.js`.

- [ ] **Step 7: Implement the credential store**

Create `src/auth/store.ts`:

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

export interface StoredCredentials {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

function configDir(): string {
  return join(process.env.HOME ?? homedir(), '.config', 'lasuite-docs-mcp');
}

export function credentialsPath(profile: string): string {
  return join(configDir(), `${profile}.json`);
}

export async function readCredentials(
  profile: string,
): Promise<StoredCredentials | null> {
  try {
    const raw = await readFile(credentialsPath(profile), 'utf8');
    const parsed = JSON.parse(raw) as StoredCredentials;
    return typeof parsed.accessToken === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeCredentials(
  profile: string,
  credentials: StoredCredentials,
): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(
    credentialsPath(profile),
    JSON.stringify(credentials, null, 2),
    { mode: 0o600 },
  );
}

export async function deleteCredentials(profile: string): Promise<void> {
  await rm(credentialsPath(profile), { force: true });
}
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
npx vitest run tests/auth/store.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 9: Commit**

```bash
git add src/config/ src/auth/ tests/config/ tests/auth/
git commit -m "Add configuration loading and credential storage"
```

---

### Task 6: OIDC discovery, PKCE, and the login flow

The login flow runs in the CLI, never in the MCP server. A server launched by Claude Code must not block on an interactive browser login.

**Files:**
- Create: `src/auth/pkce.ts`
- Create: `src/auth/oidc.ts`
- Create: `src/auth/login.ts`
- Test: `tests/auth/pkce.test.ts`
- Test: `tests/auth/oidc.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 5), `writeCredentials` / `StoredCredentials` (Task 5)
- Produces:
  - `createPkcePair(): { verifier: string; challenge: string }`
  - `interface OidcEndpoints { authorizationEndpoint: string; tokenEndpoint: string }`
  - `discoverEndpoints(issuerUrl: string): Promise<OidcEndpoints>`
  - `exchangeCode(params: { tokenEndpoint: string; clientId: string; code: string; verifier: string; redirectUri: string }): Promise<StoredCredentials>`
  - `refreshAccessToken(params: { tokenEndpoint: string; clientId: string; refreshToken: string }): Promise<StoredCredentials>`
  - `runLogin(config: Config): Promise<void>` (from `src/auth/login.ts`)

- [ ] **Step 1: Write the failing PKCE test**

Create `tests/auth/pkce.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPkcePair } from '../../src/auth/pkce.js';

describe('createPkcePair', () => {
  it('produces a verifier within the RFC 7636 length bounds', () => {
    const { verifier } = createPkcePair();

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('produces a base64url verifier with no padding', () => {
    expect(createPkcePair().verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('derives the challenge as the base64url S256 hash of the verifier', () => {
    const { verifier, challenge } = createPkcePair();
    const expected = createHash('sha256').update(verifier).digest('base64url');

    expect(challenge).toBe(expected);
  });

  it('produces a different verifier on each call', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/auth/pkce.test.ts
```

Expected: FAIL, cannot resolve `src/auth/pkce.js`.

- [ ] **Step 3: Implement PKCE**

Create `src/auth/pkce.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/auth/pkce.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing OIDC test**

Create `tests/auth/oidc.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  discoverEndpoints,
  exchangeCode,
  refreshAccessToken,
} from '../../src/auth/oidc.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn((url: string | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init)),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('discoverEndpoints', () => {
  it('reads the endpoints from the well-known document', async () => {
    stubFetch(() =>
      json({
        authorization_endpoint: 'https://sso.example.org/auth',
        token_endpoint: 'https://sso.example.org/token',
      }),
    );

    await expect(discoverEndpoints('https://sso.example.org')).resolves.toEqual({
      authorizationEndpoint: 'https://sso.example.org/auth',
      tokenEndpoint: 'https://sso.example.org/token',
    });
  });

  it('requests the standard well-known path', async () => {
    const spy = stubFetch(() =>
      json({ authorization_endpoint: 'a', token_endpoint: 't' }),
    );

    await discoverEndpoints('https://sso.example.org');

    expect(spy.mock.calls[0]?.[0]).toBe(
      'https://sso.example.org/.well-known/openid-configuration',
    );
  });

  it('fails with a clear message when discovery is unreachable', async () => {
    stubFetch(() => new Response('nope', { status: 404 }));

    await expect(discoverEndpoints('https://sso.example.org')).rejects.toThrow(
      /OIDC discovery failed/,
    );
  });
});

describe('exchangeCode', () => {
  it('converts the token response into stored credentials', async () => {
    stubFetch(() =>
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 300 }),
    );
    const before = Date.now();

    const credentials = await exchangeCode({
      tokenEndpoint: 'https://sso.example.org/token',
      clientId: 'client',
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'http://127.0.0.1:1234/callback',
    });

    expect(credentials.accessToken).toBe('at');
    expect(credentials.refreshToken).toBe('rt');
    expect(credentials.expiresAt).toBeGreaterThanOrEqual(before + 300_000 - 1_000);
  });

  it('sends the PKCE verifier in the form body', async () => {
    const spy = stubFetch(() => json({ access_token: 'at', expires_in: 60 }));

    await exchangeCode({
      tokenEndpoint: 'https://sso.example.org/token',
      clientId: 'client',
      code: 'code',
      verifier: 'the-verifier',
      redirectUri: 'http://127.0.0.1:1234/callback',
    });

    expect(String(spy.mock.calls[0]?.[1]?.body)).toContain('code_verifier=the-verifier');
  });

  it('surfaces the provider error description', async () => {
    stubFetch(() => json({ error: 'invalid_grant', error_description: 'expired' }, 400));

    await expect(
      exchangeCode({
        tokenEndpoint: 'https://sso.example.org/token',
        clientId: 'client',
        code: 'code',
        verifier: 'v',
        redirectUri: 'http://127.0.0.1:1234/callback',
      }),
    ).rejects.toThrow(/expired/);
  });
});

describe('refreshAccessToken', () => {
  it('exchanges a refresh token for new credentials', async () => {
    stubFetch(() => json({ access_token: 'new', expires_in: 120 }));

    const credentials = await refreshAccessToken({
      tokenEndpoint: 'https://sso.example.org/token',
      clientId: 'client',
      refreshToken: 'rt',
    });

    expect(credentials.accessToken).toBe('new');
  });

  it('keeps the existing refresh token when the provider omits a new one', async () => {
    stubFetch(() => json({ access_token: 'new', expires_in: 120 }));

    const credentials = await refreshAccessToken({
      tokenEndpoint: 'https://sso.example.org/token',
      clientId: 'client',
      refreshToken: 'original',
    });

    expect(credentials.refreshToken).toBe('original');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
npx vitest run tests/auth/oidc.test.ts
```

Expected: FAIL, cannot resolve `src/auth/oidc.js`.

- [ ] **Step 7: Implement OIDC discovery and token calls**

Create `src/auth/oidc.ts`:

```ts
import type { StoredCredentials } from './store.js';

export interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function discoverEndpoints(issuerUrl: string): Promise<OidcEndpoints> {
  const url = `${issuerUrl.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`OIDC discovery failed at ${url} (HTTP ${response.status}).`);
  }

  const document = (await response.json()) as {
    authorization_endpoint?: string;
    token_endpoint?: string;
  };

  if (!document.authorization_endpoint || !document.token_endpoint) {
    throw new Error(`OIDC discovery failed: ${url} omitted required endpoints.`);
  }

  return {
    authorizationEndpoint: document.authorization_endpoint,
    tokenEndpoint: document.token_endpoint,
  };
}

async function postToken(
  tokenEndpoint: string,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const payload = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok || !payload.access_token) {
    const reason = payload.error_description ?? payload.error ?? `HTTP ${response.status}`;
    throw new Error(`Token request failed: ${reason}`);
  }

  return payload;
}

function toCredentials(
  payload: TokenResponse,
  fallbackRefreshToken?: string,
): StoredCredentials {
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? fallbackRefreshToken,
    expiresAt: Date.now() + (payload.expires_in ?? 300) * 1000,
  };
}

export async function exchangeCode(params: {
  tokenEndpoint: string;
  clientId: string;
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<StoredCredentials> {
  const payload = await postToken(
    params.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: params.clientId,
      code: params.code,
      code_verifier: params.verifier,
      redirect_uri: params.redirectUri,
    }),
  );

  return toCredentials(payload);
}

export async function refreshAccessToken(params: {
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
}): Promise<StoredCredentials> {
  const payload = await postToken(
    params.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: params.clientId,
      refresh_token: params.refreshToken,
    }),
  );

  return toCredentials(payload, params.refreshToken);
}
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
npx vitest run tests/auth/oidc.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 9: Implement the interactive login flow**

Create `src/auth/login.ts`. This is driven by the CLI and verified manually against a real instance in Task 14, so it carries no unit test of its own. The redirect URI is captured alongside the code because the token exchange must send back the exact value used in the authorization request.

```ts
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import type { Config } from '../config/index.js';
import { createPkcePair } from './pkce.js';
import { discoverEndpoints, exchangeCode } from './oidc.js';
import { writeCredentials } from './store.js';

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
}

interface CallbackResult {
  code: string;
  redirectUri: string;
}

function awaitCallback(
  config: Config,
  authorizationEndpoint: string,
  challenge: string,
  state: string,
): Promise<CallbackResult> {
  return new Promise<CallbackResult>((resolve, reject) => {
    let redirectUri = '';

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }

      const finish = (message: string) => {
        response.writeHead(200, { 'content-type': 'text/plain' }).end(message);
        server.close();
      };

      if (url.searchParams.get('state') !== state) {
        finish('Login failed: state mismatch.');
        reject(new Error('Login failed: OAuth state mismatch.'));
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        finish(`Login failed: ${error}`);
        reject(new Error(`Login failed: ${error}`));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        finish('Login failed: no authorization code.');
        reject(new Error('Login failed: no authorization code returned.'));
        return;
      }

      finish('Login complete. You can close this tab and return to the terminal.');
      resolve({ code, redirectUri });
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not bind the loopback callback server.'));
        return;
      }

      redirectUri = `http://127.0.0.1:${address.port}/callback`;

      const authorizeUrl = new URL(authorizationEndpoint);
      authorizeUrl.search = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: config.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();

      process.stderr.write(`Opening ${authorizeUrl.toString()}\n`);
      openBrowser(authorizeUrl.toString());
    });
  });
}

export async function runLogin(config: Config): Promise<void> {
  const endpoints = await discoverEndpoints(config.issuerUrl);
  const { verifier, challenge } = createPkcePair();
  const state = randomBytes(16).toString('base64url');

  const { code, redirectUri } = await awaitCallback(
    config,
    endpoints.authorizationEndpoint,
    challenge,
    state,
  );

  const credentials = await exchangeCode({
    tokenEndpoint: endpoints.tokenEndpoint,
    clientId: config.clientId,
    code,
    verifier,
    redirectUri,
  });

  await writeCredentials(config.profile, credentials);
  process.stderr.write(
    `Logged in. Credentials stored for profile "${config.profile}".\n`,
  );
}
```

- [ ] **Step 10: Verify it type-checks**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 11: Run the full suite and commit**

```bash
npx vitest run && npx tsc --noEmit
git add src/auth/ tests/auth/
git commit -m "Add OIDC discovery, PKCE, and the interactive login flow"
```

---

### Task 7: Error taxonomy and the authenticated fetch

Error text is contractual: the agent reads it and decides what to do next.

**Files:**
- Create: `src/api/errors.ts`
- Create: `src/auth/client.ts`
- Test: `tests/api/errors.test.ts`
- Test: `tests/auth/client.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 5), `readCredentials` / `writeCredentials` (Task 5), `discoverEndpoints` / `refreshAccessToken` (Task 6)
- Produces:
  - `type ErrorKind = 'unauthenticated' | 'action_disabled' | 'forbidden' | 'not_found' | 'throttled' | 'conflict' | 'server' | 'network'`
  - `class DocsApiError extends Error { kind: ErrorKind; status?: number }`
  - `toDocsApiError(response: Response, context: { action: string; actionEnabled?: boolean }): DocsApiError`
  - `type AuthenticatedFetch = (path: string, init?: RequestInit) => Promise<Response>`
  - `createAuthenticatedFetch(config: Config): AuthenticatedFetch`

`path` is relative to `{docsUrl}/external_api/v1.0/`.

- [ ] **Step 1: Write the failing error test**

Create `tests/api/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DocsApiError, toDocsApiError } from '../../src/api/errors.js';

const response = (status: number, headers: Record<string, string> = {}) =>
  new Response('', { status, headers });

describe('toDocsApiError', () => {
  it('maps 401 to unauthenticated and names the login command', () => {
    const error = toDocsApiError(response(401), { action: 'list' });

    expect(error).toBeInstanceOf(DocsApiError);
    expect(error.kind).toBe('unauthenticated');
    expect(error.message).toContain('lasuite-docs-mcp login');
  });

  it('maps 403 to action_disabled when the probe found the action disabled', () => {
    const error = toDocsApiError(response(403), { action: 'search', actionEnabled: false });

    expect(error.kind).toBe('action_disabled');
    expect(error.message).toContain('EXTERNAL_API');
    expect(error.message).toContain('search');
  });

  it('maps 403 to forbidden when the action is known to be enabled', () => {
    const error = toDocsApiError(response(403), { action: 'retrieve', actionEnabled: true });

    expect(error.kind).toBe('forbidden');
    expect(error.message).not.toContain('EXTERNAL_API');
  });

  it('maps 404 without claiming the document is absent', () => {
    const error = toDocsApiError(response(404), { action: 'retrieve' });

    expect(error.kind).toBe('not_found');
    expect(error.message).toMatch(/may not exist or may not be readable/);
  });

  it('maps 429 and surfaces Retry-After', () => {
    const error = toDocsApiError(response(429, { 'retry-after': '30' }), { action: 'search' });

    expect(error.kind).toBe('throttled');
    expect(error.message).toContain('30');
  });

  it('maps 412 to conflict', () => {
    expect(toDocsApiError(response(412), { action: 'content' }).kind).toBe('conflict');
  });

  it('maps 5xx to server', () => {
    expect(toDocsApiError(response(503), { action: 'list' }).kind).toBe('server');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/api/errors.test.ts
```

Expected: FAIL, cannot resolve `src/api/errors.js`.

- [ ] **Step 3: Implement the error taxonomy**

Create `src/api/errors.ts`:

```ts
export type ErrorKind =
  | 'unauthenticated'
  | 'action_disabled'
  | 'forbidden'
  | 'not_found'
  | 'throttled'
  | 'conflict'
  | 'server'
  | 'network';

export class DocsApiError extends Error {
  readonly kind: ErrorKind;
  readonly status?: number;

  constructor(kind: ErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'DocsApiError';
    this.kind = kind;
    this.status = status;
  }
}

export function toDocsApiError(
  response: Response,
  context: { action: string; actionEnabled?: boolean },
): DocsApiError {
  const { status } = response;

  if (status === 401) {
    return new DocsApiError(
      'unauthenticated',
      'Not authenticated with Docs. Run `npx lasuite-docs-mcp login` and try again.',
      status,
    );
  }

  if (status === 403) {
    if (context.actionEnabled === false) {
      return new DocsApiError(
        'action_disabled',
        `The Docs instance does not permit the "${context.action}" action. ` +
          `Add it to the EXTERNAL_API setting's documents.actions list and restart Docs. ` +
          'Run `npx lasuite-docs-mcp doctor` for the exact value.',
        status,
      );
    }
    return new DocsApiError(
      'forbidden',
      `You do not have permission to perform "${context.action}" on this document.`,
      status,
    );
  }

  if (status === 404) {
    return new DocsApiError(
      'not_found',
      'The document may not exist or may not be readable by your account. ' +
        'Docs does not distinguish between the two.',
      status,
    );
  }

  if (status === 429) {
    const retryAfter = response.headers.get('retry-after');
    return new DocsApiError(
      'throttled',
      `Docs is rate limiting this client.${retryAfter ? ` Retry after ${retryAfter} seconds.` : ''}`,
      status,
    );
  }

  if (status === 412 || status === 409) {
    return new DocsApiError(
      'conflict',
      'The document changed since it was read. Re-read it and retry the edit.',
      status,
    );
  }

  return new DocsApiError('server', `Docs returned HTTP ${status}.`, status);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/api/errors.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing authenticated fetch test**

Create `tests/auth/client.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthenticatedFetch } from '../../src/auth/client.js';
import { readCredentials, writeCredentials } from '../../src/auth/store.js';
import { DocsApiError } from '../../src/api/errors.js';

const config = {
  docsUrl: 'https://docs.example.org',
  issuerUrl: 'https://sso.example.org',
  clientId: 'client',
  scope: 'openid',
  profile: 'default',
};

const originalHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), 'docs-mcp-'));
});

afterEach(() => {
  process.env.HOME = originalHome;
  vi.unstubAllGlobals();
});

describe('createAuthenticatedFetch', () => {
  it('fails with an actionable error when no credentials are stored', async () => {
    const authed = createAuthenticatedFetch(config);

    await expect(authed('documents/')).rejects.toThrow(DocsApiError);
    await expect(authed('documents/')).rejects.toThrow(/lasuite-docs-mcp login/);
  });

  it('sends the bearer token against the external API base path', async () => {
    await writeCredentials('default', { accessToken: 'at', expiresAt: Date.now() + 60_000 });
    const spy = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', spy);

    await createAuthenticatedFetch(config)('documents/');

    expect(spy.mock.calls[0]?.[0]).toBe(
      'https://docs.example.org/external_api/v1.0/documents/',
    );
    const headers = new Headers(spy.mock.calls[0]?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer at');
  });

  it('refreshes an expired token before the request and persists the result', async () => {
    await writeCredentials('default', {
      accessToken: 'old',
      refreshToken: 'rt',
      expiresAt: Date.now() - 1_000,
    });

    const spy = vi.fn((url: string | URL) => {
      if (String(url).includes('.well-known')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ authorization_endpoint: 'a', token_endpoint: 'https://sso/t' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (String(url) === 'https://sso/t') {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: 'fresh', expires_in: 300 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    vi.stubGlobal('fetch', spy);

    await createAuthenticatedFetch(config)('documents/');

    expect((await readCredentials('default'))?.accessToken).toBe('fresh');
    const last = new Headers(spy.mock.calls.at(-1)?.[1]?.headers);
    expect(last.get('authorization')).toBe('Bearer fresh');
  });

  it('tells the user to log in again when the refresh token is rejected', async () => {
    await writeCredentials('default', {
      accessToken: 'old',
      refreshToken: 'bad',
      expiresAt: Date.now() - 1_000,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL) =>
        Promise.resolve(
          String(url).includes('.well-known')
            ? new Response(
                JSON.stringify({ authorization_endpoint: 'a', token_endpoint: 'https://sso/t' }),
                { status: 200, headers: { 'content-type': 'application/json' } },
              )
            : new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
        ),
      ),
    );

    await expect(createAuthenticatedFetch(config)('documents/')).rejects.toThrow(
      /lasuite-docs-mcp login/,
    );
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
npx vitest run tests/auth/client.test.ts
```

Expected: FAIL, cannot resolve `src/auth/client.js`.

- [ ] **Step 7: Implement the authenticated fetch**

Create `src/auth/client.ts`:

```ts
import type { Config } from '../config/index.js';
import { DocsApiError } from '../api/errors.js';
import { discoverEndpoints, refreshAccessToken } from './oidc.js';
import { readCredentials, writeCredentials, type StoredCredentials } from './store.js';

export type AuthenticatedFetch = (path: string, init?: RequestInit) => Promise<Response>;

const LOGIN_HINT = 'Run `npx lasuite-docs-mcp login` and try again.';
const EXPIRY_SKEW_MS = 30_000;

async function currentCredentials(config: Config): Promise<StoredCredentials> {
  const stored = await readCredentials(config.profile);

  if (!stored) {
    throw new DocsApiError(
      'unauthenticated',
      `No stored credentials for profile "${config.profile}". ${LOGIN_HINT}`,
    );
  }

  if (stored.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return stored;
  }

  if (!stored.refreshToken) {
    throw new DocsApiError(
      'unauthenticated',
      `The stored access token has expired and there is no refresh token. ${LOGIN_HINT}`,
    );
  }

  try {
    const endpoints = await discoverEndpoints(config.issuerUrl);
    const refreshed = await refreshAccessToken({
      tokenEndpoint: endpoints.tokenEndpoint,
      clientId: config.clientId,
      refreshToken: stored.refreshToken,
    });
    await writeCredentials(config.profile, refreshed);
    return refreshed;
  } catch {
    throw new DocsApiError(
      'unauthenticated',
      `Could not refresh the stored session. ${LOGIN_HINT}`,
    );
  }
}

export function createAuthenticatedFetch(config: Config): AuthenticatedFetch {
  const base = `${config.docsUrl}/external_api/v1.0/`;

  return async (path, init = {}) => {
    const credentials = await currentCredentials(config);
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${credentials.accessToken}`);

    return fetch(new URL(path, base).toString(), { ...init, headers });
  };
}
```

- [ ] **Step 8: Run the test to verify it passes**

```bash
npx vitest run tests/auth/client.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 9: Commit**

```bash
git add src/api/errors.ts src/auth/client.ts tests/api/errors.test.ts tests/auth/client.test.ts
git commit -m "Add API error taxonomy and authenticated request layer"
```

---

### Task 8: Docs API client

**Files:**
- Create: `src/api/types.ts`
- Create: `src/api/client.ts`
- Test: `tests/api/client.test.ts`

**Interfaces:**
- Consumes: `AuthenticatedFetch` (Task 7), `toDocsApiError` / `DocsApiError` (Task 7)
- Produces:
  - `interface DocumentSummary { id: string; title: string; path?: string; createdAt?: string; updatedAt?: string }`
  - `interface TreeNode { id: string; title: string; children: TreeNode[] }`
  - `interface ContentWithEtag { base64: string; etag: string | null }`
  - `class DocsClient` with:
    - `listDocuments(params?: { title?: string; isFavorite?: boolean; isCreatorMe?: boolean; ordering?: string; pageSize?: number }): Promise<DocumentSummary[]>`
    - `searchDocuments(query: string, pageSize?: number): Promise<DocumentSummary[]>`
    - `getDocument(id: string): Promise<DocumentSummary>`
    - `getTree(id: string): Promise<TreeNode>`
    - `listFavorites(): Promise<DocumentSummary[]>`
    - `getFormattedContent(id: string, format: 'json' | 'markdown' | 'html'): Promise<unknown>`
    - `getContentWithEtag(id: string): Promise<ContentWithEtag>`
    - `patchContent(id: string, base64: string): Promise<void>`
    - `canEdit(id: string): Promise<boolean>`
    - `createDocument(title: string, parentId?: string): Promise<DocumentSummary>`
  - `setActionEnabled(action: string, enabled: boolean): void` on the client, used by the capability probe in Task 9 so 403s can be classified

- [ ] **Step 1: Write the failing client test**

Create `tests/api/client.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { DocsClient } from '../../src/api/client.js';
import { DocsApiError } from '../../src/api/errors.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function clientWith(handler: (path: string, init?: RequestInit) => Response) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new DocsClient(async (path, init) => {
    calls.push({ path, init });
    return handler(path, init);
  });
  return { client, calls };
}

describe('DocsClient', () => {
  it('unwraps the paginated results envelope when listing', async () => {
    const { client } = clientWith(() => json({ results: [{ id: '1', title: 'A' }] }));

    await expect(client.listDocuments()).resolves.toEqual([{ id: '1', title: 'A' }]);
  });

  it('accepts a bare array when the endpoint is not paginated', async () => {
    const { client } = clientWith(() => json([{ id: '1', title: 'A' }]));

    await expect(client.listFavorites()).resolves.toEqual([{ id: '1', title: 'A' }]);
  });

  it('passes list filters as query parameters', async () => {
    const { client, calls } = clientWith(() => json({ results: [] }));

    await client.listDocuments({ title: 'spec', isFavorite: true, pageSize: 5 });

    expect(calls[0]?.path).toContain('title=spec');
    expect(calls[0]?.path).toContain('is_favorite=true');
    expect(calls[0]?.path).toContain('page_size=5');
  });

  it('sends the search query to the search endpoint', async () => {
    const { client, calls } = clientWith(() => json({ results: [] }));

    await client.searchDocuments('release notes');

    expect(calls[0]?.path).toContain('documents/search/');
    expect(calls[0]?.path).toContain('q=release+notes');
  });

  it('returns markdown from the formatted-content envelope', async () => {
    const { client, calls } = clientWith(() =>
      json({ id: '1', title: 'A', content: '# Hi', created_at: null, updated_at: null }),
    );

    await expect(client.getFormattedContent('1', 'markdown')).resolves.toBe('# Hi');
    expect(calls[0]?.path).toContain('content_format=markdown');
  });

  it('treats null formatted content as an empty document', async () => {
    const { client } = clientWith(() => json({ id: '1', title: 'A', content: null }));

    await expect(client.getFormattedContent('1', 'markdown')).resolves.toBe('');
  });

  it('returns an empty block list for a null json content envelope', async () => {
    const { client } = clientWith(() => json({ id: '1', title: 'A', content: null }));

    await expect(client.getFormattedContent('1', 'json')).resolves.toEqual([]);
  });

  it('captures the ETag alongside raw content', async () => {
    const { client } = clientWith(
      () => new Response('YmFzZTY0', { status: 200, headers: { etag: '"abc"' } }),
    );

    await expect(client.getContentWithEtag('1')).resolves.toEqual({
      base64: 'YmFzZTY0',
      etag: '"abc"',
    });
  });

  it('never sends the websocket bypass flag when writing content', async () => {
    const { client, calls } = clientWith(() => new Response('', { status: 204 }));

    await client.patchContent('1', 'YmFzZTY0');

    const body = String(calls[0]?.init?.body);
    expect(body).toContain('YmFzZTY0');
    expect(body).not.toContain('websocket');
  });

  it('reads the can_edit flag', async () => {
    const { client } = clientWith(() => json({ can_edit: false }));

    await expect(client.canEdit('1')).resolves.toBe(false);
  });

  it('creates a child document under a parent', async () => {
    const { client, calls } = clientWith(() => json({ id: '2', title: 'Child' }, 201));

    await client.createDocument('Child', 'parent-id');

    expect(calls[0]?.path).toBe('documents/parent-id/children/');
  });

  it('creates a root document when no parent is given', async () => {
    const { client, calls } = clientWith(() => json({ id: '2', title: 'Root' }, 201));

    await client.createDocument('Root');

    expect(calls[0]?.path).toBe('documents/');
  });

  it('raises a classified error for a failed request', async () => {
    const { client } = clientWith(() => new Response('', { status: 404 }));

    await expect(client.getDocument('missing')).rejects.toThrow(DocsApiError);
    await expect(client.getDocument('missing')).rejects.toThrow(/may not exist/);
  });

  it('classifies a 403 as a configuration problem once the probe marks the action disabled', async () => {
    const { client } = clientWith(() => new Response('', { status: 403 }));
    client.setActionEnabled('search', false);

    await expect(client.searchDocuments('x')).rejects.toThrow(/EXTERNAL_API/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/api/client.test.ts
```

Expected: FAIL, cannot resolve `src/api/client.js`.

- [ ] **Step 3: Define the API types**

Create `src/api/types.ts`:

```ts
export interface DocumentSummary {
  id: string;
  title: string;
  path?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TreeNode {
  id: string;
  title: string;
  children: TreeNode[];
}

export interface ContentWithEtag {
  base64: string;
  etag: string | null;
}
```

- [ ] **Step 4: Implement the client**

Create `src/api/client.ts`:

```ts
import type { AuthenticatedFetch } from '../auth/client.js';
import { toDocsApiError } from './errors.js';
import type { ContentWithEtag, DocumentSummary, TreeNode } from './types.js';

interface RawDocument {
  id: string;
  title?: string | null;
  path?: string;
  created_at?: string;
  updated_at?: string;
  children?: RawDocument[];
}

function toSummary(raw: RawDocument): DocumentSummary {
  return {
    id: raw.id,
    title: raw.title ?? 'Untitled',
    path: raw.path,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

function toTree(raw: RawDocument): TreeNode {
  return {
    id: raw.id,
    title: raw.title ?? 'Untitled',
    children: (raw.children ?? []).map(toTree),
  };
}

export class DocsClient {
  private readonly actionEnabled = new Map<string, boolean>();

  constructor(private readonly request: AuthenticatedFetch) {}

  setActionEnabled(action: string, enabled: boolean): void {
    this.actionEnabled.set(action, enabled);
  }

  isActionEnabled(action: string): boolean | undefined {
    return this.actionEnabled.get(action);
  }

  private async send(path: string, action: string, init?: RequestInit): Promise<Response> {
    const response = await this.request(path, init);

    if (!response.ok) {
      throw toDocsApiError(response, {
        action,
        actionEnabled: this.actionEnabled.get(action),
      });
    }

    return response;
  }

  private async sendJson<T>(path: string, action: string, init?: RequestInit): Promise<T> {
    return (await this.send(path, action, init)).json() as Promise<T>;
  }

  private async sendList(path: string, action: string): Promise<DocumentSummary[]> {
    const payload = await this.sendJson<RawDocument[] | { results?: RawDocument[] }>(
      path,
      action,
    );
    const rows = Array.isArray(payload) ? payload : (payload.results ?? []);
    return rows.map(toSummary);
  }

  async listDocuments(params: {
    title?: string;
    isFavorite?: boolean;
    isCreatorMe?: boolean;
    ordering?: string;
    pageSize?: number;
  } = {}): Promise<DocumentSummary[]> {
    const query = new URLSearchParams();
    if (params.title) query.set('title', params.title);
    if (params.isFavorite !== undefined) query.set('is_favorite', String(params.isFavorite));
    if (params.isCreatorMe !== undefined) query.set('is_creator_me', String(params.isCreatorMe));
    if (params.ordering) query.set('ordering', params.ordering);
    if (params.pageSize) query.set('page_size', String(params.pageSize));

    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.sendList(`documents/${suffix}`, 'list');
  }

  async searchDocuments(query: string, pageSize = 20): Promise<DocumentSummary[]> {
    const params = new URLSearchParams({ q: query, page_size: String(pageSize) });
    return this.sendList(`documents/search/?${params.toString()}`, 'search');
  }

  async listFavorites(): Promise<DocumentSummary[]> {
    return this.sendList('documents/favorite_list/', 'favorite_list');
  }

  async getDocument(id: string): Promise<DocumentSummary> {
    return toSummary(await this.sendJson<RawDocument>(`documents/${id}/`, 'retrieve'));
  }

  async getTree(id: string): Promise<TreeNode> {
    return toTree(await this.sendJson<RawDocument>(`documents/${id}/tree/`, 'tree'));
  }

  async getFormattedContent(
    id: string,
    format: 'json' | 'markdown' | 'html',
  ): Promise<unknown> {
    const payload = await this.sendJson<{ content: unknown }>(
      `documents/${id}/formatted-content/?content_format=${format}`,
      'formatted_content',
    );

    if (payload.content === null || payload.content === undefined) {
      return format === 'json' ? [] : '';
    }
    return payload.content;
  }

  async getContentWithEtag(id: string): Promise<ContentWithEtag> {
    const response = await this.send(`documents/${id}/content/`, 'content_retrieve');
    return { base64: (await response.text()).trim(), etag: response.headers.get('etag') };
  }

  async patchContent(id: string, base64: string): Promise<void> {
    // The serializer accepts a `websocket` flag that bypasses the collaboration
    // lock. We never send it; bypassing the lock overwrites live edits.
    await this.send(`documents/${id}/content/`, 'content', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: base64 }),
    });
  }

  async canEdit(id: string): Promise<boolean> {
    const payload = await this.sendJson<{ can_edit: boolean }>(
      `documents/${id}/can-edit/`,
      'can_edit',
    );
    return payload.can_edit;
  }

  async createDocument(title: string, parentId?: string): Promise<DocumentSummary> {
    const path = parentId ? `documents/${parentId}/children/` : 'documents/';
    const action = parentId ? 'children' : 'create';

    return toSummary(
      await this.sendJson<RawDocument>(path, action, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      }),
    );
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run tests/api/client.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 6: Commit**

```bash
git add src/api/ tests/api/
git commit -m "Add typed Docs API client"
```

---

### Task 9: Capability probe

Read actions are probed at startup so tools backed by disabled actions are never registered. Write actions cannot be probed without side effects, so they are assumed available and rely on the 403 classification from Task 7.

**Files:**
- Create: `src/api/capabilities.ts`
- Test: `tests/api/capabilities.test.ts`

**Interfaces:**
- Consumes: `DocsClient` (Task 8)
- Produces:
  - `const PROBED_ACTIONS: readonly string[]` — `['list', 'search', 'tree', 'formatted_content']`
  - `const ASSUMED_ACTIONS: readonly string[]` — `['retrieve', 'create', 'children', 'content', 'content_retrieve', 'can_edit']`
  - `interface Capabilities { enabled: Set<string>; probed: Record<string, boolean> }`
  - `probeCapabilities(client: DocsClient): Promise<Capabilities>`

- [ ] **Step 1: Write the failing test**

Create `tests/api/capabilities.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { probeCapabilities } from '../../src/api/capabilities.js';
import { DocsClient } from '../../src/api/client.js';
import { DocsApiError } from '../../src/api/errors.js';

function clientWhere(failing: Set<string>) {
  const client = new DocsClient(async () => new Response('{}', { status: 200 }));

  const reject = (action: string) =>
    Promise.reject(new DocsApiError('forbidden', 'nope', 403));

  vi.spyOn(client, 'listDocuments').mockImplementation(() =>
    failing.has('list') ? reject('list') : Promise.resolve([]),
  );
  vi.spyOn(client, 'searchDocuments').mockImplementation(() =>
    failing.has('search') ? reject('search') : Promise.resolve([]),
  );
  vi.spyOn(client, 'getTree').mockImplementation(() =>
    failing.has('tree')
      ? reject('tree')
      : Promise.resolve({ id: 'x', title: 'x', children: [] }),
  );
  vi.spyOn(client, 'getFormattedContent').mockImplementation(() =>
    failing.has('formatted_content') ? reject('formatted_content') : Promise.resolve(''),
  );

  return client;
}

describe('probeCapabilities', () => {
  it('marks every probed action enabled when all succeed', async () => {
    const capabilities = await probeCapabilities(clientWhere(new Set()));

    expect(capabilities.enabled.has('search')).toBe(true);
    expect(capabilities.enabled.has('tree')).toBe(true);
  });

  it('marks a probed action disabled when it is rejected', async () => {
    const capabilities = await probeCapabilities(clientWhere(new Set(['search'])));

    expect(capabilities.enabled.has('search')).toBe(false);
    expect(capabilities.probed.search).toBe(false);
  });

  it('assumes unprobeable write actions are available', async () => {
    const capabilities = await probeCapabilities(clientWhere(new Set(['search'])));

    expect(capabilities.enabled.has('content')).toBe(true);
    expect(capabilities.enabled.has('create')).toBe(true);
    expect(capabilities.probed.content).toBeUndefined();
  });

  it('records the probe result on the client so 403s can be classified', async () => {
    const client = clientWhere(new Set(['search']));

    await probeCapabilities(client);

    expect(client.isActionEnabled('search')).toBe(false);
    expect(client.isActionEnabled('list')).toBe(true);
  });

  it('does not let one failing probe abort the others', async () => {
    const capabilities = await probeCapabilities(
      clientWhere(new Set(['list', 'tree'])),
    );

    expect(capabilities.enabled.has('search')).toBe(true);
    expect(capabilities.enabled.has('formatted_content')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/api/capabilities.test.ts
```

Expected: FAIL, cannot resolve `src/api/capabilities.js`.

- [ ] **Step 3: Implement the probe**

Create `src/api/capabilities.ts`:

```ts
import type { DocsClient } from './client.js';

export const PROBED_ACTIONS = ['list', 'search', 'tree', 'formatted_content'] as const;

// Cannot be probed without side effects, so we assume they work and rely on
// classified 403s to explain the failure when they do not.
export const ASSUMED_ACTIONS = [
  'retrieve',
  'create',
  'children',
  'content',
  'content_retrieve',
  'can_edit',
] as const;

export interface Capabilities {
  enabled: Set<string>;
  probed: Record<string, boolean>;
}

const PROBE_DOCUMENT_ID = '00000000-0000-0000-0000-000000000000';

async function probe(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    // A 404 means the action ran and the placeholder document simply is not
    // there, which still tells us the action is permitted.
    const kind = (error as { kind?: string }).kind;
    return kind === 'not_found';
  }
}

export async function probeCapabilities(client: DocsClient): Promise<Capabilities> {
  const results = await Promise.all([
    probe(() => client.listDocuments({ pageSize: 1 })),
    probe(() => client.searchDocuments('', 1)),
    probe(() => client.getTree(PROBE_DOCUMENT_ID)),
    probe(() =>
      client.getFormattedContent(PROBE_DOCUMENT_ID, 'markdown'),
    ),
  ]);

  const probed: Record<string, boolean> = {};
  PROBED_ACTIONS.forEach((action, index) => {
    probed[action] = results[index] ?? false;
  });

  const enabled = new Set<string>(ASSUMED_ACTIONS);
  for (const [action, ok] of Object.entries(probed)) {
    client.setActionEnabled(action, ok);
    if (ok) {
      enabled.add(action);
    }
  }
  for (const action of ASSUMED_ACTIONS) {
    client.setActionEnabled(action, true);
  }

  return { enabled, probed };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/api/capabilities.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/api/capabilities.ts tests/api/capabilities.test.ts
git commit -m "Add startup capability probing"
```

---

### Task 10: MCP server and the read tools

First working milestone. After this task the server is usable in Claude Code for search, browse, and read.

Each tool file exports a pure core function plus a `register…` wrapper, so the logic is testable without standing up an MCP server.

**Files:**
- Create: `src/tools/types.ts`
- Create: `src/tools/format.ts`
- Create: `src/tools/search.ts`
- Create: `src/tools/list.ts`
- Create: `src/tools/tree.ts`
- Create: `src/tools/read.ts`
- Create: `src/server.ts`
- Test: `tests/tools/format.test.ts`
- Test: `tests/tools/read.test.ts`

**Interfaces:**
- Consumes: `DocsClient` (Task 8), `Capabilities` (Task 9), `markdownToBlocks` / `blocksToMarkdown` (Task 2), `indexHeadings` / `resolveAnchor` (Task 3)
- Produces:
  - `interface McpServerLike` (from `src/tools/types.ts`) — structural server type shared by all tool modules
  - `renderDocumentList(documents: DocumentSummary[]): string`
  - `renderTree(node: TreeNode): string`
  - `renderOutline(entries: HeadingEntry[]): string`
  - `toolResult(text: string): { content: [{ type: 'text'; text: string }] }`
  - `readDocument(client: DocsClient, params: { id: string; section?: string; maxChars?: number }): Promise<string>`
  - `registerSearchTool`, `registerListTool`, `registerTreeTool`, `registerReadTool`, each `(server: McpServer, client: DocsClient) => void`
  - `createServer(client: DocsClient, capabilities: Capabilities): McpServer`

- [ ] **Step 1: Write the failing formatting test**

Create `tests/tools/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderDocumentList, renderOutline, renderTree } from '../../src/tools/format.js';

describe('renderDocumentList', () => {
  it('renders one line per document with the id', () => {
    const output = renderDocumentList([
      { id: 'abc', title: 'Spec', updatedAt: '2026-09-01T10:00:00Z' },
    ]);

    expect(output).toContain('Spec');
    expect(output).toContain('abc');
  });

  it('says so plainly when there are no results', () => {
    expect(renderDocumentList([])).toBe('No documents matched.');
  });
});

describe('renderTree', () => {
  it('indents children beneath their parent', () => {
    const output = renderTree({
      id: '1',
      title: 'Root',
      children: [{ id: '2', title: 'Child', children: [] }],
    });

    expect(output.split('\n')[0]).toContain('Root');
    expect(output.split('\n')[1]).toMatch(/^\s+.*Child/);
  });
});

describe('renderOutline', () => {
  it('lists anchors so the caller knows what to request', () => {
    const output = renderOutline([
      { anchor: 'Setup', text: 'Setup', level: 2, startIndex: 0, endIndex: 2 },
    ]);

    expect(output).toContain('Setup');
  });

  it('reports an empty outline for a document with no headings', () => {
    expect(renderOutline([])).toContain('no headings');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/tools/format.test.ts
```

Expected: FAIL, cannot resolve `src/tools/format.js`.

- [ ] **Step 3: Implement the shared tool types and formatters**

Create `src/tools/types.ts`. This structural type keeps each tool module from importing the SDK's server class directly, which also makes the tools testable without one.

```ts
export interface McpServerLike {
  registerTool(
    name: string,
    config: { description: string; inputSchema: unknown },
    handler: (params: never) => Promise<{ content: Array<{ type: 'text'; text: string }> }>,
  ): void;
}
```

Create `src/tools/format.ts`:

```ts
import type { DocumentSummary, TreeNode } from '../api/types.js';
import type { HeadingEntry } from '../content/headings.js';

export function renderDocumentList(documents: DocumentSummary[]): string {
  if (documents.length === 0) {
    return 'No documents matched.';
  }

  return documents
    .map((document) => {
      const updated = document.updatedAt ? ` (updated ${document.updatedAt})` : '';
      return `- ${document.title}${updated}\n  id: ${document.id}`;
    })
    .join('\n');
}

export function renderTree(node: TreeNode, depth = 0): string {
  const indent = '  '.repeat(depth);
  const lines = [`${indent}- ${node.title}  [${node.id}]`];

  for (const child of node.children) {
    lines.push(renderTree(child, depth + 1));
  }

  return lines.join('\n');
}

export function renderOutline(entries: HeadingEntry[]): string {
  if (entries.length === 0) {
    return 'This document has no headings, so it cannot be read by section.';
  }

  return entries
    .map((entry) => `${'  '.repeat(Math.max(0, entry.level - 1))}- ${entry.anchor}`)
    .join('\n');
}

export function toolResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/tools/format.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing read test**

Create `tests/tools/read.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { readDocument } from '../../src/tools/read.js';
import { DocsClient } from '../../src/api/client.js';

function clientReturning(content: Record<'markdown' | 'json', unknown>) {
  const client = new DocsClient(async () => new Response('{}', { status: 200 }));
  vi.spyOn(client, 'getFormattedContent').mockImplementation((_id, format) =>
    Promise.resolve(content[format as 'markdown' | 'json']),
  );
  return client;
}

const heading = (level: number, text: string) => ({
  type: 'heading',
  props: { level },
  content: text,
});
const para = (text: string) => ({ type: 'paragraph', content: text });

describe('readDocument', () => {
  it('returns the whole document as markdown by default', async () => {
    const client = clientReturning({ markdown: '# Title\n\nBody', json: [] });

    await expect(readDocument(client, { id: '1' })).resolves.toContain('# Title');
  });

  it('returns only the requested section', async () => {
    const client = clientReturning({
      markdown: 'unused',
      json: [heading(2, 'One'), para('first'), heading(2, 'Two'), para('second')],
    });

    const output = await readDocument(client, { id: '1', section: 'Two' });

    expect(output).toContain('second');
    expect(output).not.toContain('first');
  });

  it('lists the available anchors when the section is unknown', async () => {
    const client = clientReturning({
      markdown: 'unused',
      json: [heading(2, 'One'), heading(2, 'Two')],
    });

    await expect(readDocument(client, { id: '1', section: 'Nope' })).rejects.toThrow(
      /One, Two/,
    );
  });

  it('returns an outline instead of content past maxChars', async () => {
    const client = clientReturning({
      markdown: '# Title\n\n' + 'x'.repeat(500),
      json: [heading(1, 'Title'), para('x'.repeat(500))],
    });

    const output = await readDocument(client, { id: '1', maxChars: 100 });

    expect(output).toContain('Title');
    expect(output).toContain('section');
    expect(output).not.toContain('x'.repeat(200));
  });

  it('reports an empty document plainly', async () => {
    const client = clientReturning({ markdown: '', json: [] });

    await expect(readDocument(client, { id: '1' })).resolves.toContain('empty');
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

```bash
npx vitest run tests/tools/read.test.ts
```

Expected: FAIL, cannot resolve `src/tools/read.js`.

- [ ] **Step 7: Implement the read tool**

Create `src/tools/read.ts`:

```ts
import { z } from 'zod';

import type { DocsClient } from '../api/client.js';
import { blocksToMarkdown } from '../content/convert.js';
import { indexHeadings, resolveAnchor } from '../content/headings.js';
import type { DocsBlock } from '../content/types.js';
import { renderOutline, toolResult } from './format.js';
import type { McpServerLike } from './types.js';

export const DEFAULT_MAX_CHARS = 20_000;

export async function readDocument(
  client: DocsClient,
  params: { id: string; section?: string; maxChars?: number },
): Promise<string> {
  const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;

  if (params.section) {
    const blocks = (await client.getFormattedContent(params.id, 'json')) as DocsBlock[];
    const entry = resolveAnchor(indexHeadings(blocks), params.section);
    const markdown = await blocksToMarkdown(blocks.slice(entry.startIndex, entry.endIndex));
    return markdown.trim().length > 0 ? markdown : 'This section is empty.';
  }

  const markdown = (await client.getFormattedContent(params.id, 'markdown')) as string;

  if (markdown.trim().length === 0) {
    return 'This document is empty.';
  }

  if (markdown.length <= maxChars) {
    return markdown;
  }

  const blocks = (await client.getFormattedContent(params.id, 'json')) as DocsBlock[];
  const outline = renderOutline(indexHeadings(blocks));

  return (
    `This document is ${markdown.length} characters, over the ${maxChars} limit, ` +
    'so here is its outline instead. Call docs_read again with a "section" ' +
    `argument set to one of these anchors:\n\n${outline}`
  );
}

export function registerReadTool(server: McpServerLike, client: DocsClient): void {
  server.registerTool(
    'docs_read',
    {
      description:
        'Read a Docs document as markdown. Pass "section" to read only one heading. ' +
        'Large documents return an outline of section anchors instead of full content.',
      inputSchema: z.object({
        id: z.string().describe('Document UUID'),
        section: z.string().optional().describe('Heading anchor, e.g. "Setup" or "Setup#2"'),
        maxChars: z.number().int().positive().optional(),
      }),
    },
    async (params) => toolResult(await readDocument(client, params)),
  );
}

```

- [ ] **Step 8: Run the test to verify it passes**

```bash
npx vitest run tests/tools/read.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 9: Implement the search, list, and tree tools**

Create `src/tools/search.ts`:

```ts
import { z } from 'zod';

import type { DocsClient } from '../api/client.js';
import { renderDocumentList, toolResult } from './format.js';
import type { McpServerLike } from './types.js';

export function registerSearchTool(server: McpServerLike, client: DocsClient): void {
  server.registerTool(
    'docs_search',
    {
      description:
        'Search documents on the Docs instance by text. Returns titles and ids; ' +
        'use docs_read to fetch content.',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().positive().max(100).optional(),
      }),
    },
    async ({ query, limit }: { query: string; limit?: number }) =>
      toolResult(renderDocumentList(await client.searchDocuments(query, limit ?? 20))),
  );
}
```

Create `src/tools/list.ts`:

```ts
import { z } from 'zod';

import type { DocsClient } from '../api/client.js';
import { renderDocumentList, toolResult } from './format.js';
import type { McpServerLike } from './types.js';

export function registerListTool(server: McpServerLike, client: DocsClient): void {
  server.registerTool(
    'docs_list',
    {
      description:
        'Browse documents: recent, favorites, or those you created. ' +
        'Use docs_search when you have a query.',
      inputSchema: z.object({
        title: z.string().optional().describe('Substring match on the title'),
        isFavorite: z.boolean().optional(),
        isCreatorMe: z.boolean().optional(),
        ordering: z.enum(['created_at', '-created_at', 'updated_at', '-updated_at', 'title', '-title']).optional(),
        limit: z.number().int().positive().max(200).optional(),
      }),
    },
    async (params: {
      title?: string;
      isFavorite?: boolean;
      isCreatorMe?: boolean;
      ordering?: string;
      limit?: number;
    }) =>
      toolResult(
        renderDocumentList(
          await client.listDocuments({
            title: params.title,
            isFavorite: params.isFavorite,
            isCreatorMe: params.isCreatorMe,
            ordering: params.ordering ?? '-updated_at',
            pageSize: params.limit ?? 20,
          }),
        ),
      ),
  );
}
```

Create `src/tools/tree.ts`:

```ts
import { z } from 'zod';

import type { DocsClient } from '../api/client.js';
import { renderTree, toolResult } from './format.js';
import type { McpServerLike } from './types.js';

export function registerTreeTool(server: McpServerLike, client: DocsClient): void {
  server.registerTool(
    'docs_tree',
    {
      description:
        'Show the document hierarchy around a document: its ancestors and its children. ' +
        'Cheaper than reading content when orienting in a wiki.',
      inputSchema: z.object({ id: z.string().describe('Document UUID') }),
    },
    async ({ id }: { id: string }) => toolResult(renderTree(await client.getTree(id))),
  );
}
```

- [ ] **Step 10: Wire the server**

Create `src/server.ts`:

```ts
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
```

- [ ] **Step 11: Verify the build and the whole suite**

```bash
npx tsc --noEmit && npx vitest run
```

Expected: no type errors, all tests pass.

- [ ] **Step 12: Commit**

```bash
git add src/tools/ src/server.ts tests/tools/
git commit -m "Add MCP server with search, browse, and read tools"
```

---

### Task 11: Document creation

Creates an empty document, then writes its content through the same pipeline edits use. That reuse is the point: one write path, tested once.

**Files:**
- Create: `src/edit/writeContent.ts`
- Create: `src/tools/create.ts`
- Test: `tests/edit/writeContent.test.ts`
- Modify: `src/server.ts` (register the new tool)

**Interfaces:**
- Consumes: `DocsClient` (Task 8), `blocksToYjsBase64` / `markdownToBlocks` (Task 2)
- Produces:
  - `writeBlocks(client: DocsClient, id: string, blocks: DocsBlock[]): Promise<void>`
  - `createDocumentFromMarkdown(client: DocsClient, params: { title: string; markdown: string; parentId?: string }): Promise<DocumentSummary>`
  - `registerCreateTool(server: McpServerLike, client: DocsClient): void`

- [ ] **Step 1: Write the failing test**

Create `tests/edit/writeContent.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createDocumentFromMarkdown, writeBlocks } from '../../src/edit/writeContent.js';
import { DocsClient } from '../../src/api/client.js';
import { yjsBase64ToBlocks } from '../../src/content/convert.js';

function stubClient() {
  const client = new DocsClient(async () => new Response('{}', { status: 200 }));
  const patch = vi.spyOn(client, 'patchContent').mockResolvedValue(undefined);
  const create = vi
    .spyOn(client, 'createDocument')
    .mockResolvedValue({ id: 'new-id', title: 'New' });
  return { client, patch, create };
}

describe('writeBlocks', () => {
  it('sends base64 Yjs that decodes back to the same block types', async () => {
    const { client, patch } = stubClient();

    await writeBlocks(client, 'doc-1', [
      { type: 'paragraph', content: 'hello' },
    ] as never);

    const base64 = patch.mock.calls[0]?.[1] as string;
    expect(yjsBase64ToBlocks(base64).map((block) => block.type)).toContain('paragraph');
  });
});

describe('createDocumentFromMarkdown', () => {
  it('creates the document then writes its content', async () => {
    const { client, patch, create } = stubClient();

    const summary = await createDocumentFromMarkdown(client, {
      title: 'Notes',
      markdown: '# Notes\n\nBody',
    });

    expect(create).toHaveBeenCalledWith('Notes', undefined);
    expect(patch.mock.calls[0]?.[0]).toBe('new-id');
    expect(summary.id).toBe('new-id');
  });

  it('passes the parent through so the document is nested', async () => {
    const { client, create } = stubClient();

    await createDocumentFromMarkdown(client, {
      title: 'Child',
      markdown: 'x',
      parentId: 'parent-id',
    });

    expect(create).toHaveBeenCalledWith('Child', 'parent-id');
  });

  it('creates an empty document without writing content', async () => {
    const { client, patch } = stubClient();

    await createDocumentFromMarkdown(client, { title: 'Empty', markdown: '' });

    expect(patch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/edit/writeContent.test.ts
```

Expected: FAIL, cannot resolve `src/edit/writeContent.js`.

- [ ] **Step 3: Implement the write helpers**

Create `src/edit/writeContent.ts`:

```ts
import type { DocsClient } from '../api/client.js';
import type { DocumentSummary } from '../api/types.js';
import { blocksToYjsBase64, markdownToBlocks } from '../content/convert.js';
import type { DocsBlock } from '../content/types.js';

export async function writeBlocks(
  client: DocsClient,
  id: string,
  blocks: DocsBlock[],
): Promise<void> {
  await client.patchContent(id, blocksToYjsBase64(blocks));
}

export async function createDocumentFromMarkdown(
  client: DocsClient,
  params: { title: string; markdown: string; parentId?: string },
): Promise<DocumentSummary> {
  const summary = await client.createDocument(params.title, params.parentId);

  if (params.markdown.trim().length > 0) {
    await writeBlocks(client, summary.id, await markdownToBlocks(params.markdown));
  }

  return summary;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/edit/writeContent.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Implement the create tool**

Create `src/tools/create.ts`:

```ts
import { z } from 'zod';

import type { DocsClient } from '../api/client.js';
import { createDocumentFromMarkdown } from '../edit/writeContent.js';
import { toolResult } from './format.js';
import type { McpServerLike } from './types.js';

export function registerCreateTool(server: McpServerLike, client: DocsClient): void {
  server.registerTool(
    'docs_create',
    {
      description:
        'Create a new Docs document from markdown. Pass parentId to nest it under ' +
        'an existing document.',
      inputSchema: z.object({
        title: z.string().min(1),
        markdown: z.string().default(''),
        parentId: z.string().optional().describe('UUID of the parent document'),
      }),
    },
    async (params: { title: string; markdown: string; parentId?: string }) => {
      const summary = await createDocumentFromMarkdown(client, params);
      return toolResult(`Created "${summary.title}"\nid: ${summary.id}`);
    },
  );
}
```

- [ ] **Step 6: Register the tool in `src/server.ts`**

Add the import and the registration inside `createServer`:

```ts
import { registerCreateTool } from './tools/create.js';

// inside createServer, after the read tool registration:
  if (capabilities.enabled.has('create')) {
    registerCreateTool(server, client);
  }
```

- [ ] **Step 7: Verify and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/edit/ src/tools/ src/server.ts tests/edit/
git commit -m "Add document creation from markdown"
```

---

### Task 12: Editing existing documents

The payoff task. Everything before it exists to make this correct.

**Files:**
- Create: `src/edit/editDocument.ts`
- Create: `src/tools/edit.ts`
- Test: `tests/edit/editDocument.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `DocsClient` (Task 8), `spliceBlocks` / `SpliceOperation` (Task 4), `detectLossyBlocks` / `LossyFinding` (Task 4), `markdownToBlocks` (Task 2), `writeBlocks` (Task 11)
- Produces:
  - `class LossyEditError extends Error { findings: LossyFinding[] }`
  - `class DocumentLockedError extends Error`
  - `class StaleDocumentError extends Error`
  - `interface EditResult { operation: SpliceOperation; blockCount: number; discarded: LossyFinding[] }`
  - `editDocument(client: DocsClient, params: { id: string; operation: SpliceOperation; markdown: string; section?: string; confirmLossy?: boolean }): Promise<EditResult>`
  - `registerEditTool(server: McpServerLike, client: DocsClient): void`

Order of operations matters and is asserted by the tests: check the lock, read blocks and the ETag, splice, check lossiness, re-check the ETag, then write.

- [ ] **Step 1: Write the failing test**

Create `tests/edit/editDocument.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  DocumentLockedError,
  LossyEditError,
  StaleDocumentError,
  editDocument,
} from '../../src/edit/editDocument.js';
import { DocsClient } from '../../src/api/client.js';
import { yjsBase64ToBlocks } from '../../src/content/convert.js';

const heading = (level: number, text: string) => ({
  type: 'heading',
  props: { level },
  content: text,
});
const para = (text: string) => ({ type: 'paragraph', content: text });

function stubClient(options: {
  blocks?: unknown[];
  canEdit?: boolean;
  etags?: string[];
} = {}) {
  const client = new DocsClient(async () => new Response('{}', { status: 200 }));
  const etags = options.etags ?? ['"v1"', '"v1"'];
  let etagCall = 0;

  vi.spyOn(client, 'canEdit').mockResolvedValue(options.canEdit ?? true);
  vi.spyOn(client, 'getFormattedContent').mockResolvedValue(
    options.blocks ?? [heading(2, 'One'), para('a'), heading(2, 'Two'), para('b')],
  );
  vi.spyOn(client, 'getContentWithEtag').mockImplementation(() =>
    Promise.resolve({ base64: '', etag: etags[etagCall++] ?? etags.at(-1) ?? null }),
  );
  const patch = vi.spyOn(client, 'patchContent').mockResolvedValue(undefined);

  return { client, patch };
}

describe('editDocument', () => {
  it('appends without touching existing content', async () => {
    const { client, patch } = stubClient();

    const result = await editDocument(client, {
      id: '1',
      operation: 'append',
      markdown: 'tail',
    });

    const written = yjsBase64ToBlocks(patch.mock.calls[0]?.[1] as string);
    expect(written.length).toBeGreaterThan(4);
    expect(result.discarded).toEqual([]);
  });

  it('replaces only the targeted section', async () => {
    const { client, patch } = stubClient();

    await editDocument(client, {
      id: '1',
      operation: 'replace_section',
      markdown: '## One\n\nnew',
      section: 'One',
    });

    const written = yjsBase64ToBlocks(patch.mock.calls[0]?.[1] as string);
    const text = JSON.stringify(written);
    expect(text).toContain('new');
    expect(text).toContain('Two');
    expect(text).not.toContain('"a"');
  });

  it('refuses when another party holds the document open', async () => {
    const { client, patch } = stubClient({ canEdit: false });

    await expect(
      editDocument(client, { id: '1', operation: 'append', markdown: 'x' }),
    ).rejects.toThrow(DocumentLockedError);
    expect(patch).not.toHaveBeenCalled();
  });

  it('aborts when the document changed between read and write', async () => {
    const { client, patch } = stubClient({ etags: ['"v1"', '"v2"'] });

    await expect(
      editDocument(client, { id: '1', operation: 'append', markdown: 'x' }),
    ).rejects.toThrow(StaleDocumentError);
    expect(patch).not.toHaveBeenCalled();
  });

  it('refuses a whole-document replace that would discard a callout', async () => {
    const { client, patch } = stubClient({
      blocks: [{ type: 'callout', props: { emoji: '💡' }, content: 'keep me' }],
    });

    await expect(
      editDocument(client, { id: '1', operation: 'replace', markdown: 'new' }),
    ).rejects.toThrow(LossyEditError);
    expect(patch).not.toHaveBeenCalled();
  });

  it('proceeds with a lossy replace once confirmed, and reports what went', async () => {
    const { client, patch } = stubClient({
      blocks: [{ type: 'callout', props: { emoji: '💡' }, content: 'bye' }],
    });

    const result = await editDocument(client, {
      id: '1',
      operation: 'replace',
      markdown: 'new',
      confirmLossy: true,
    });

    expect(result.discarded).toEqual([{ type: 'callout', count: 1 }]);
    expect(patch).toHaveBeenCalled();
  });

  it('reports lossy discards for a section edit without requiring confirmation', async () => {
    const { client, patch } = stubClient({
      blocks: [heading(2, 'One'), { type: 'pdf', props: {} }, heading(2, 'Two')],
    });

    const result = await editDocument(client, {
      id: '1',
      operation: 'replace_section',
      markdown: '## One\n\nnew',
      section: 'One',
    });

    expect(result.discarded).toEqual([{ type: 'pdf', count: 1 }]);
    expect(patch).toHaveBeenCalled();
  });

  it('surfaces the available anchors for an unknown section', async () => {
    const { client } = stubClient();

    await expect(
      editDocument(client, {
        id: '1',
        operation: 'replace_section',
        markdown: 'x',
        section: 'Nope',
      }),
    ).rejects.toThrow(/One, Two/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/edit/editDocument.test.ts
```

Expected: FAIL, cannot resolve `src/edit/editDocument.js`.

- [ ] **Step 3: Implement the edit orchestration**

Create `src/edit/editDocument.ts`:

```ts
import type { DocsClient } from '../api/client.js';
import { markdownToBlocks } from '../content/convert.js';
import { detectLossyBlocks, type LossyFinding } from '../content/lossy.js';
import { spliceBlocks, type SpliceOperation } from '../content/splice.js';
import type { DocsBlock } from '../content/types.js';
import { writeBlocks } from './writeContent.js';

export class DocumentLockedError extends Error {
  constructor() {
    super(
      'Someone currently has this document open in Docs. Editing now would be ' +
        'rejected or would overwrite their session. Try again once they are done.',
    );
    this.name = 'DocumentLockedError';
  }
}

export class StaleDocumentError extends Error {
  constructor() {
    super(
      'The document changed while this edit was being prepared. Nothing was ' +
        'written. Read it again and retry.',
    );
    this.name = 'StaleDocumentError';
  }
}

export class LossyEditError extends Error {
  readonly findings: LossyFinding[];

  constructor(findings: LossyFinding[]) {
    const summary = findings.map((f) => `${f.count}x ${f.type}`).join(', ');
    super(
      `This edit would discard content markdown cannot represent (${summary}). ` +
        'Read the document first, then pass confirmLossy: true if that is intended.',
    );
    this.name = 'LossyEditError';
    this.findings = findings;
  }
}

export interface EditResult {
  operation: SpliceOperation;
  blockCount: number;
  discarded: LossyFinding[];
}

export async function editDocument(
  client: DocsClient,
  params: {
    id: string;
    operation: SpliceOperation;
    markdown: string;
    section?: string;
    confirmLossy?: boolean;
  },
): Promise<EditResult> {
  if (!(await client.canEdit(params.id))) {
    throw new DocumentLockedError();
  }

  const existing = (await client.getFormattedContent(params.id, 'json')) as DocsBlock[];
  const { etag: etagBefore } = await client.getContentWithEtag(params.id);

  const incoming = await markdownToBlocks(params.markdown);
  const { blocks, discarded } = spliceBlocks(
    existing,
    incoming,
    params.operation,
    params.section,
  );

  const findings = detectLossyBlocks(discarded);
  if (findings.length > 0 && params.operation === 'replace' && !params.confirmLossy) {
    throw new LossyEditError(findings);
  }

  const { etag: etagAfter } = await client.getContentWithEtag(params.id);
  if (etagBefore !== etagAfter) {
    throw new StaleDocumentError();
  }

  await writeBlocks(client, params.id, blocks);

  return { operation: params.operation, blockCount: blocks.length, discarded: findings };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/edit/editDocument.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Implement the edit tool**

Create `src/tools/edit.ts`:

```ts
import { z } from 'zod';

import type { DocsClient } from '../api/client.js';
import { editDocument } from '../edit/editDocument.js';
import { toolResult } from './format.js';
import type { McpServerLike } from './types.js';

export function registerEditTool(server: McpServerLike, client: DocsClient): void {
  server.registerTool(
    'docs_edit',
    {
      description:
        'Edit an existing Docs document with markdown. Operations: replace (whole ' +
        'document), append, prepend, replace_section, insert_after_section. Section ' +
        'operations need a heading anchor from docs_read. Content outside the edited ' +
        'range is preserved exactly, including blocks markdown cannot express.',
      inputSchema: z.object({
        id: z.string().describe('Document UUID'),
        operation: z.enum([
          'replace',
          'append',
          'prepend',
          'replace_section',
          'insert_after_section',
        ]),
        markdown: z.string(),
        section: z.string().optional().describe('Heading anchor, required for section operations'),
        confirmLossy: z
          .boolean()
          .optional()
          .describe('Allow a whole-document replace to discard non-markdown blocks'),
      }),
    },
    async (params: {
      id: string;
      operation: 'replace' | 'append' | 'prepend' | 'replace_section' | 'insert_after_section';
      markdown: string;
      section?: string;
      confirmLossy?: boolean;
    }) => {
      const result = await editDocument(client, params);
      const lost =
        result.discarded.length > 0
          ? `\nDiscarded: ${result.discarded.map((f) => `${f.count}x ${f.type}`).join(', ')}`
          : '';

      return toolResult(
        `Applied ${result.operation}. Document now has ${result.blockCount} blocks.${lost}`,
      );
    },
  );
}
```

- [ ] **Step 6: Register the tool in `src/server.ts`**

```ts
import { registerEditTool } from './tools/edit.js';

// inside createServer, after the create tool registration:
  if (capabilities.enabled.has('content') && capabilities.enabled.has('formatted_content')) {
    registerEditTool(server, client);
  }
```

- [ ] **Step 7: Verify and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/edit/ src/tools/ src/server.ts tests/edit/
git commit -m "Add block-space editing for existing documents"
```

---

### Task 13: Document resources

Lets a document be @-mentioned into context directly rather than fetched by the agent.

**Files:**
- Create: `src/resources/documents.ts`
- Test: `tests/resources/documents.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `DocsClient` (Task 8)
- Produces:
  - `parseDocumentUri(uri: string): string` — returns the document id, throws on a malformed URI
  - `documentUri(id: string): string`
  - `registerDocumentResources(server: ResourceCapableServer, client: DocsClient): Promise<void>` — async because favorites are fetched at registration time

- [ ] **Step 1: Write the failing test**

Create `tests/resources/documents.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { documentUri, parseDocumentUri } from '../../src/resources/documents.js';

describe('document URIs', () => {
  it('builds a docs:// URI from an id', () => {
    expect(documentUri('abc-123')).toBe('docs://document/abc-123');
  });

  it('round-trips an id', () => {
    expect(parseDocumentUri(documentUri('abc-123'))).toBe('abc-123');
  });

  it('rejects a URI with the wrong scheme', () => {
    expect(() => parseDocumentUri('https://document/abc')).toThrow(/docs:\/\/document/);
  });

  it('rejects a URI with no id', () => {
    expect(() => parseDocumentUri('docs://document/')).toThrow(/docs:\/\/document/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/resources/documents.test.ts
```

Expected: FAIL, cannot resolve `src/resources/documents.js`.

- [ ] **Step 3: Implement the resources**

Create `src/resources/documents.ts`:

```ts
import type { DocsClient } from '../api/client.js';

const PREFIX = 'docs://document/';

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
  } catch {
    // Favorites are a convenience. An instance that denies them should not
    // prevent the server from starting.
    return;
  }

  for (const favorite of favorites) {
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/resources/documents.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Wire resources into the server**

`createServer` becomes async because favorites are fetched at registration time. Update `src/server.ts`:

```ts
import { registerDocumentResources } from './resources/documents.js';

export async function createServer(
  client: DocsClient,
  capabilities: Capabilities,
): Promise<McpServer> {
  // ...existing tool registrations unchanged...

  if (capabilities.enabled.has('formatted_content')) {
    await registerDocumentResources(server, client);
  }

  return server;
}
```

And in `main`, await it before serving:

```ts
  const server = await createServer(client, capabilities);
  serveStdio(() => server);
```

- [ ] **Step 6: Verify and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/resources/ src/server.ts tests/resources/
git commit -m "Expose favorited documents as MCP resources"
```

---

### Task 14: CLI and documentation

**Files:**
- Create: `src/cli.ts`
- Create: `README.md`
- Test: `tests/cli/doctor.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 5), `runLogin` (Task 6), `deleteCredentials` / `readCredentials` (Task 5), `probeCapabilities` (Task 9)
- Produces:
  - `renderDoctorReport(capabilities: Capabilities): string`
  - `main(argv: string[]): Promise<number>` — the CLI entry point, returns an exit code

- [ ] **Step 1: Write the failing doctor test**

Create `tests/cli/doctor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderDoctorReport } from '../../src/cli.js';

describe('renderDoctorReport', () => {
  it('reports each probed action as available or blocked', () => {
    const report = renderDoctorReport({
      enabled: new Set(['list', 'tree']),
      probed: { list: true, search: false, tree: true, formatted_content: false },
    });

    expect(report).toMatch(/list.*available/i);
    expect(report).toMatch(/search.*blocked/i);
  });

  it('prints the EXTERNAL_API value to set when something is blocked', () => {
    const report = renderDoctorReport({
      enabled: new Set(['list']),
      probed: { list: true, search: false, tree: true, formatted_content: true },
    });

    expect(report).toContain('EXTERNAL_API');
    expect(report).toContain('"search"');
    expect(report).toContain('formatted_content');
  });

  it('confirms a fully configured instance without printing a fix', () => {
    const report = renderDoctorReport({
      enabled: new Set(['list', 'search', 'tree', 'formatted_content']),
      probed: { list: true, search: true, tree: true, formatted_content: true },
    });

    expect(report).toMatch(/all probed actions are available/i);
    expect(report).not.toContain('EXTERNAL_API');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run tests/cli/doctor.test.ts
```

Expected: FAIL, cannot resolve `src/cli.js`.

- [ ] **Step 3: Implement the CLI**

Create `src/cli.ts`:

```ts
#!/usr/bin/env node
import { DocsClient } from './api/client.js';
import {
  probeCapabilities,
  PROBED_ACTIONS,
  type Capabilities,
} from './api/capabilities.js';
import { createAuthenticatedFetch } from './auth/client.js';
import { runLogin } from './auth/login.js';
import { deleteCredentials, readCredentials } from './auth/store.js';
import { loadConfig } from './config/index.js';

const REQUIRED_ACTIONS = [
  'list',
  'retrieve',
  'create',
  'children',
  'tree',
  'search',
  'content',
  'content_retrieve',
  'formatted_content',
  'can_edit',
];

export function renderDoctorReport(capabilities: Capabilities): string {
  const lines = ['Probed actions:'];

  for (const action of PROBED_ACTIONS) {
    lines.push(`  ${action}: ${capabilities.probed[action] ? 'available' : 'blocked'}`);
  }

  const blocked = PROBED_ACTIONS.filter((action) => !capabilities.probed[action]);

  if (blocked.length === 0) {
    lines.push('', 'All probed actions are available.');
    return lines.join('\n');
  }

  lines.push(
    '',
    `Blocked: ${blocked.join(', ')}.`,
    'Set this EXTERNAL_API value on the Docs instance and restart it:',
    '',
    JSON.stringify(
      {
        documents: { enabled: true, actions: REQUIRED_ACTIONS },
        users: { enabled: true, actions: ['get_me'] },
      },
      null,
      2,
    ),
  );

  return lines.join('\n');
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[2] ?? 'help';
  const config = loadConfig(process.env);

  switch (command) {
    case 'login':
      await runLogin(config);
      return 0;

    case 'logout':
      await deleteCredentials(config.profile);
      process.stdout.write(`Cleared credentials for profile "${config.profile}".\n`);
      return 0;

    case 'status': {
      const credentials = await readCredentials(config.profile);
      if (!credentials) {
        process.stdout.write(`Not logged in (profile "${config.profile}").\n`);
        return 1;
      }
      const expiry = new Date(credentials.expiresAt).toISOString();
      process.stdout.write(
        `Logged in to ${config.docsUrl} (profile "${config.profile}"), token expires ${expiry}.\n`,
      );
      return 0;
    }

    case 'doctor': {
      const client = new DocsClient(createAuthenticatedFetch(config));
      process.stdout.write(`${renderDoctorReport(await probeCapabilities(client))}\n`);
      return 0;
    }

    default:
      process.stdout.write(
        'Usage: lasuite-docs-mcp <login|logout|status|doctor>\n\n' +
          'Environment: DOCS_URL, DOCS_OIDC_ISSUER, DOCS_OIDC_CLIENT_ID,\n' +
          'optional DOCS_OIDC_SCOPE and DOCS_PROFILE.\n',
      );
      return command === 'help' ? 0 : 1;
  }
}

if (process.argv[1]?.endsWith('cli.js')) {
  main(process.argv)
    .then((code) => process.exit(code))
    .catch((error: Error) => {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run tests/cli/doctor.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Add the server entry point**

Create `src/index.ts`:

```ts
#!/usr/bin/env node
import { main } from './server.js';

main().catch((error: Error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
```

Add it to `package.json` `bin`:

```json
  "bin": {
    "lasuite-docs-mcp": "./dist/cli.js",
    "lasuite-docs-mcp-server": "./dist/index.js"
  }
```

- [ ] **Step 6: Write the README**

Create `README.md` covering, in this order:

1. What it does, in two sentences.
2. **Instance requirements** — the `OIDC_RESOURCE_SERVER_ENABLED` block and the `EXTERNAL_API` JSON from the spec, verbatim.
3. **Setup** — install, set `DOCS_URL` / `DOCS_OIDC_ISSUER` / `DOCS_OIDC_CLIENT_ID`, run `login`, run `doctor`.
4. **Claude Code registration** — the `claude mcp add` invocation with the env vars.
5. **Tools** — one line each for the six tools.
6. **Known limitations**, stated plainly:
   - An edit rewrites the document's full Yjs state, so collaborative undo history across that edit is lost. Upstream's markdown import behaves the same way.
   - Editing is refused while someone has the document open in a browser.
   - A whole-document `replace` refuses to discard callouts, PDF blocks, upload loaders, or page breaks unless `confirmLossy` is set.
   - BlockNote is pinned to 0.54.0 to match Docs `v5.6.1`. Upgrading Docs may require re-running `npm run vendor` and the contract suite.

- [ ] **Step 7: Verify and commit**

```bash
npx tsc --noEmit && npx vitest run
git add src/cli.ts src/index.ts package.json README.md tests/cli/
git commit -m "Add CLI commands and project documentation"
```

---

### Task 15: Contract suite against a real instance

The test that protects the architecture's one real risk. It is opt-in because it needs a running Docs.

**Files:**
- Create: `vitest.contract.config.ts`
- Create: `tests/contract/README.md`
- Create: `tests/contract/conversion.contract.test.ts`
- Create: `scripts/check-drift.sh`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/contract.yml`
- Modify: `package.json` (add the `check:drift` script)

**Interfaces:**
- Consumes: everything
- Produces: no source interfaces; this task adds verification only

- [ ] **Step 1: Create the contract vitest config**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/contract/**/*.contract.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
```

- [ ] **Step 2: Document how to run it**

Create `tests/contract/README.md`:

```markdown
# Contract suite

These tests run against a live Docs instance. They are excluded from `npm test`
and only run via `npm run test:contract`.

## What they need

- A reachable Docs instance with the full `EXTERNAL_API` allowlist from the
  README, and `OIDC_RESOURCE_SERVER_ENABLED=True`
- A stored session: run `npx lasuite-docs-mcp login` first
- `DOCS_URL`, `DOCS_OIDC_ISSUER`, and `DOCS_OIDC_CLIENT_ID` in the environment

## What they do to it

They create real documents and leave them in place. Point this at a scratch
instance, not anything holding content worth keeping.

## When they fail

A failure means the vendored BlockNote schema and the instance disagree. Check
whether the instance's Docs version still matches the ref pinned in
`scripts/vendor-blockspecs.sh`, re-run `npm run vendor`, and re-run
`npm run check:drift`.
```

- [ ] **Step 3: Write the contract test**

Create `tests/contract/conversion.contract.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';

import { DocsClient } from '../../src/api/client.js';
import { createAuthenticatedFetch } from '../../src/auth/client.js';
import { loadConfig } from '../../src/config/index.js';
import { blocksToYjsBase64, markdownToBlocks } from '../../src/content/convert.js';
import { createDocumentFromMarkdown } from '../../src/edit/writeContent.js';
import { editDocument } from '../../src/edit/editDocument.js';

let client: DocsClient;

beforeAll(() => {
  client = new DocsClient(createAuthenticatedFetch(loadConfig(process.env)));
});

describe('conversion contract', () => {
  it('accepts locally generated Yjs and reads it back as equivalent markdown', async () => {
    const markdown = '# Contract\n\nA paragraph with **bold** text.\n\n## Section\n\n- one\n- two';

    const summary = await createDocumentFromMarkdown(client, {
      title: `contract-${Date.now()}`,
      markdown,
    });

    const readBack = (await client.getFormattedContent(summary.id, 'markdown')) as string;

    expect(readBack).toContain('# Contract');
    expect(readBack).toContain('**bold**');
    expect(readBack).toContain('## Section');
    expect(readBack).toContain('one');
  });

  it('agrees with the instance converter on block structure', async () => {
    const markdown = '# Heading\n\nBody text.';
    const localBlocks = await markdownToBlocks(markdown);

    const summary = await createDocumentFromMarkdown(client, {
      title: `contract-blocks-${Date.now()}`,
      markdown,
    });

    const remoteBlocks = (await client.getFormattedContent(summary.id, 'json')) as Array<{
      type: string;
    }>;

    expect(remoteBlocks.map((block) => block.type)).toEqual(
      localBlocks.map((block) => block.type),
    );
  });

  it('preserves a section edit against a real document', async () => {
    const summary = await createDocumentFromMarkdown(client, {
      title: `contract-edit-${Date.now()}`,
      markdown: '## One\n\nfirst\n\n## Two\n\nsecond',
    });

    await editDocument(client, {
      id: summary.id,
      operation: 'replace_section',
      markdown: '## One\n\nrewritten',
      section: 'One',
    });

    const readBack = (await client.getFormattedContent(summary.id, 'markdown')) as string;

    expect(readBack).toContain('rewritten');
    expect(readBack).toContain('second');
    expect(readBack).not.toContain('first');
  });

  it('round-trips an empty document without error', async () => {
    const summary = await createDocumentFromMarkdown(client, {
      title: `contract-empty-${Date.now()}`,
      markdown: '',
    });

    await expect(client.getFormattedContent(summary.id, 'markdown')).resolves.toBe('');
  });

  it('produces base64 the backend accepts for a direct content write', async () => {
    const summary = await createDocumentFromMarkdown(client, {
      title: `contract-patch-${Date.now()}`,
      markdown: 'initial',
    });

    const blocks = await markdownToBlocks('patched directly');
    await expect(
      client.patchContent(summary.id, blocksToYjsBase64(blocks)),
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 4: Run the contract suite against a scratch instance**

```bash
DOCS_URL=... DOCS_OIDC_ISSUER=... DOCS_OIDC_CLIENT_ID=... npm run test:contract
```

Expected: PASS, 5 tests. A failure here means the vendored schema and the instance disagree; re-run `npm run vendor` and check whether the instance's Docs version still matches the pinned ref.

- [ ] **Step 5: Add the drift canary script**

The contract suite needs a live instance. This check does not, so it can run on every pull request. It re-downloads the pinned block specs and diffs them against what is vendored, catching an upstream change before it corrupts a document.

Create `scripts/check-drift.sh`:

```bash
#!/usr/bin/env bash
# Fails when the vendored block specs no longer match the pinned upstream ref.
set -euo pipefail

REF="$(grep -oE 'REF="[^"]+"' "$(dirname "$0")/vendor-blockspecs.sh" | cut -d'"' -f2)"
BASE="https://raw.githubusercontent.com/suitenumerique/docs/${REF}/src/frontend/servers/y-provider/src/blockSpecs"
VENDORED="$(dirname "$0")/../src/content/blockSpecs"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

for file in index Callout Pdf UploadLoader InterlinkingLinkInline; do
  curl -fsSL "${BASE}/${file}.ts" -o "${TEMP}/${file}.ts"
done

# Re-apply the same import rewrite the vendoring script performs.
sed -i.bak "s|from '@/blockSpecs'|from './blockSpecs/index.js'|g" "${TEMP}"/*.ts
rm -f "${TEMP}"/*.bak

if diff -r "${TEMP}" "${VENDORED}" > /dev/null 2>&1; then
  echo "block specs match upstream ${REF}"
  exit 0
fi

echo "Vendored block specs have drifted from upstream ${REF}:"
diff -r "${TEMP}" "${VENDORED}" || true
echo
echo "Run 'npm run vendor', then 'npm run test:contract' before committing."
exit 1
```

Add the script to `package.json`:

```json
    "check:drift": "bash scripts/check-drift.sh"
```

Run it and confirm it passes against the freshly vendored files:

```bash
chmod +x scripts/check-drift.sh && npm run check:drift
```

Expected: `block specs match upstream v5.6.1`.

- [ ] **Step 6: Add the CI workflows**

Create `.github/workflows/ci.yml`:

```yaml
name: ci

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm test
      - run: npm run check:drift
```

Create `.github/workflows/contract.yml`:

```yaml
name: contract

on:
  schedule:
    - cron: '0 6 * * 1'
  pull_request:
    paths:
      - 'package.json'
      - 'src/content/**'
  workflow_dispatch:

jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Check whether instance secrets are configured
        id: secrets
        env:
          DOCS_URL: ${{ secrets.DOCS_URL }}
        run: echo "available=${DOCS_URL:+yes}" >> "$GITHUB_OUTPUT"

      - if: steps.secrets.outputs.available != 'yes'
        run: echo "No instance configured; skipping the contract suite."

      - if: steps.secrets.outputs.available == 'yes'
        run: npm ci

      - if: steps.secrets.outputs.available == 'yes'
        run: npm run test:contract
        env:
          DOCS_URL: ${{ secrets.DOCS_URL }}
          DOCS_OIDC_ISSUER: ${{ secrets.DOCS_OIDC_ISSUER }}
          DOCS_OIDC_CLIENT_ID: ${{ secrets.DOCS_OIDC_CLIENT_ID }}
```

Forks without the secrets skip the job rather than failing it.

- [ ] **Step 7: Commit**

```bash
git add vitest.contract.config.ts tests/contract/ scripts/check-drift.sh package.json .github/
git commit -m "Add contract suite and schema drift detection"
```

---

## Verification

After Task 15, all of the following should hold:

```bash
npx tsc --noEmit          # no type errors
npx vitest run            # unit suite green, no live instance needed
npm run check:drift       # vendored schema still matches upstream v5.6.1
npm run test:contract     # green against a scratch Docs instance
```

Manual check in Claude Code: register the server, then confirm `docs_search` returns results, `docs_read` renders a real document, `docs_create` produces a document visible in the web UI, and `docs_edit` with `replace_section` changes only the targeted section while leaving a callout elsewhere in the document intact.
