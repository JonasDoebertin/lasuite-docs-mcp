import { DocsApiError } from './errors.js';
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
  // Docs never gates this behind the EXTERNAL_API allowlist, so it is safe
  // to assume available without probing it.
  'favorite_list',
] as const;

export interface Capabilities {
  enabled: Set<string>;
  probed: Record<string, boolean>;
}

// An all-zeros UUID that can never be a real document. Docs runs the
// allowlist/permission check before it looks the document up, so a 404 for
// this ID proves the action was allowed to run and only the target is
// missing.
const PROBE_DOCUMENT_ID = '00000000-0000-0000-0000-000000000000';

// Docs' EXTERNAL_API allowlist rejects a blocked action with 403, and 403
// only -- that is the one and only signal that means "disabled." A 404
// means the action ran against the placeholder document (success). A
// transient server/network/throttled failure reaches here only after
// DocsClient has already exhausted 3 retries, so by this point it is a
// sustained problem, not a blip -- which makes "disable the tool for the
// whole session" an even worse response to it, not a safer one. An
// unexpected 400 is equally silent about permission. And an unrecognised,
// non-API exception is the most ambiguous signal there is, so it gets the
// same treatment: assumed to work. This is deliberately asymmetric. A tool
// that is wrongly left enabled fails loudly and classifiably the first time
// it's actually used; a tool that is wrongly disabled just isn't there --
// no error, no log line, nothing to search for. Only a documented 403 may
// disable a tool; nothing else in this function does.
function actionWorks(error: unknown): boolean {
  if (error instanceof DocsApiError) {
    return error.kind !== 'forbidden' && error.kind !== 'action_disabled';
  }
  return true;
}

// An ordinary request tolerates up to MAX_ATTEMPTS * REQUEST_TIMEOUT_MS
// (3 * 30s = 90s) before giving up on a hung connection. This probe runs
// before a stdio MCP server can answer its client's `initialize` handshake,
// and four of these run per startup -- 90s per probe is not a cost this
// path can afford. 5s is short enough to keep a hung instance from stalling
// the handshake noticeably, and generous next to the latency any working
// instance actually needs to answer a page_size=1 list or a 404 lookup.
//
// This races the probe rather than cancelling it: DocsClient's public
// methods don't accept a caller-supplied AbortSignal, so the underlying
// request (and any retries it's mid-flight on) keeps running in the
// background and its result is simply discarded. That is an acceptable
// trade for not stalling startup -- a timed-out probe is treated the same
// as any other ambiguous, non-403 failure below: assumed to work.
export const PROBE_TIMEOUT_MS = 5_000;

class ProbeTimeoutError extends Error {
  constructor() {
    super('Capability probe timed out.');
    this.name = 'ProbeTimeoutError';
  }
}

function withProbeTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProbeTimeoutError()), PROBE_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function probe(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await withProbeTimeout(run());
    return true;
  } catch (error) {
    return actionWorks(error);
  }
}

export async function probeCapabilities(client: DocsClient): Promise<Capabilities> {
  const results = await Promise.all([
    probe(() => client.listDocuments({ pageSize: 1 })),
    // A harmless non-empty query: an empty `q` can be rejected as a 400 on a
    // real backend, which would be misread as "search is disabled".
    probe(() => client.searchDocuments('a', 1)),
    probe(() => client.getTree(PROBE_DOCUMENT_ID)),
    probe(() => client.getFormattedContent(PROBE_DOCUMENT_ID, 'markdown')),
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
