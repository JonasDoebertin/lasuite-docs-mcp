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
// only. A 404 means the action ran against the placeholder document
// (success). A transient server/network/throttled failure -- already
// retried up to 3 times inside DocsClient -- or an unexpected 400 says
// nothing about whether the action is permitted; classifying those as
// "disabled" would silently drop a working tool because of an outage
// instead of surfacing the outage as a real error on first use. An
// unrecognised, non-API error is treated conservatively as "disabled":
// there is no evidence the action works.
function actionWorks(error: unknown): boolean {
  if (error instanceof DocsApiError) {
    return error.kind !== 'forbidden' && error.kind !== 'action_disabled';
  }
  return false;
}

async function probe(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
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
