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
