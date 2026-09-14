import type { DocsClient } from '../api/client.js';
import { yjsBase64ToBlocks } from '../content/convert.js';
import { detectLossyBlocks, type LossyFinding } from '../content/lossy.js';
import { spliceBlocks, type SpliceOperation } from '../content/splice.js';
import type { DocsBlock } from '../content/types.js';
import { convertMarkdownToBlocks } from './conversion.js';
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

// A byte-length threshold was tried here first and rejected: ordinary
// collaborative editing history (Yjs tombstones and delete-set overhead from
// insert/delete cycles) can push an honestly-empty document's encoded state
// past any threshold that still leaves room for real content below it. The
// only comparison that means what we actually want is decoding the raw
// state with the same conversion this project already uses everywhere else,
// and comparing block counts directly instead of guessing from size.
type EmptyReadCheck =
  | { falselyEmpty: false }
  | { falselyEmpty: true; reason: 'mismatch' | 'unparseable'; cause?: unknown };

function checkEmptyRead(base64: string): EmptyReadCheck {
  let decoded: DocsBlock[];
  try {
    decoded = yjsBase64ToBlocks(base64);
  } catch (cause) {
    // A raw state we cannot parse at all is not one we should overwrite --
    // it might be an instance-specific representation this project's schema
    // doesn't recognise, and either way "unreadable" is not "empty".
    return { falselyEmpty: true, reason: 'unparseable', cause };
  }

  if (decoded.length > 0) {
    return { falselyEmpty: true, reason: 'mismatch' };
  }
  return { falselyEmpty: false };
}

export class UnreadableDocumentError extends Error {
  constructor(reason: 'mismatch' | 'unparseable', cause?: unknown) {
    const detail =
      reason === 'mismatch'
        ? 'formatted-content reported no blocks, but decoding the raw Yjs state ' +
          'locally finds real content.'
        : 'formatted-content reported no blocks, and the raw Yjs state could not ' +
          'be decoded locally either, so it cannot be confirmed empty.';
    super(
      `Docs returned this document as empty, but that could not be verified: ${detail} ` +
        'Refusing to write: proceeding could replace real content with only the new markdown.',
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'UnreadableDocumentError';
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
  // False when the Docs instance did not send an ETag on either read, so
  // the concurrent-modification check below had nothing to compare and was
  // skipped rather than silently passing. `canEdit` is still the primary
  // lock check either way -- this only means the second safety net was
  // unavailable, not that the edit was unsafe.
  staleCheckPerformed: boolean;
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

  // Capture the ETag before reading the blocks, not after: a concurrent
  // write landing between the two reads would otherwise already be baked
  // into etagBefore, making the staleness comparison below pass on a
  // document that changed out from under this read. Reading the ETag first
  // collapses that window to zero.
  const { etag: etagBefore, base64: base64Before } = await client.getContentWithEtag(params.id);
  const existing = (await client.getFormattedContent(params.id, 'json')) as DocsBlock[];

  if (existing.length === 0) {
    const emptyReadCheck = checkEmptyRead(base64Before);
    if (emptyReadCheck.falselyEmpty) {
      // The raw state and the formatted read are two separate requests, so a
      // write landing between them produces this exact disagreement with
      // nothing wrong with the document or the schema: the raw snapshot still
      // holds the content that the formatted read, taken afterwards, no longer
      // sees. Ask whether the document simply moved before blaming the read. A
      // changed ETag means the two snapshots are different revisions, which is
      // the staleness case the comparison further down already handles, and
      // "read it again and retry" is the advice that actually resolves it.
      // Only 'mismatch' can be explained this way; a state we cannot decode at
      // all is unreadable whether or not anyone else was writing.
      if (emptyReadCheck.reason === 'mismatch' && etagBefore !== null) {
        const { etag: etagNow } = await client.getContentWithEtag(params.id);
        if (etagNow !== etagBefore) {
          throw new StaleDocumentError();
        }
      }
      throw new UnreadableDocumentError(emptyReadCheck.reason, emptyReadCheck.cause);
    }
  }

  const incoming = await convertMarkdownToBlocks(params.markdown);
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

  // A null ETag means the instance (or a proxy in front of it) never sends
  // one, not that the document is unchanged -- comparing null to null would
  // pass every time and make the guard silently inert. Skip the comparison
  // rather than perform one that means nothing, and say so in the result.
  const staleCheckPerformed = etagBefore !== null;
  if (staleCheckPerformed && etagBefore !== etagAfter) {
    throw new StaleDocumentError();
  }

  await writeBlocks(client, params.id, blocks);

  return {
    operation: params.operation,
    blockCount: blocks.length,
    discarded: findings,
    staleCheckPerformed,
  };
}
