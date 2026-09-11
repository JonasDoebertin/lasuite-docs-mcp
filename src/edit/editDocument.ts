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
  // A DocsApiError thrown here (rather than a `false` result) is not caught:
  // it propagates and blocks the edit. We cannot verify the document is safe
  // to write, so failing closed is the only option that cannot overwrite a
  // human's in-progress edit.
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
  // Only a whole-document replace requires explicit confirmation: it is the
  // one operation that can silently discard content the caller never named
  // in the request. Section operations name their target anchor, so a lossy
  // discard there is expected fallout of the caller's own instruction --
  // reporting it in the result is enough; blocking it would just make every
  // section edit of a document containing a callout a two-round-trip dance.
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
