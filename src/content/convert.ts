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
