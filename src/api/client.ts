import type { AuthenticatedFetch } from '../auth/client.js';
import { DocsApiError, toDocsApiError, type ErrorKind } from './errors.js';
import type { ContentWithEtag, DocumentSummary, TreeNode } from './types.js';

// `formatted_content` is an undocumented action: nothing guarantees its
// envelope shape on an instance we don't control. Casting `content` straight
// to `DocsBlock[]` would let a shape change reach the edit path as silent
// truncation (a non-array read as `[]`-like and treated as "no blocks").
// Fail loudly instead so the caller can tell "empty document" apart from
// "the API returned something we didn't expect".
export class MalformedContentError extends Error {
  constructor(id: string) {
    super(
      `Docs returned formatted-content for document ${id} in an unexpected shape: ` +
        'content_format=json did not resolve to an array. This may mean the ' +
        "instance's API has changed; treat this document's content as unreadable " +
        'rather than assume it is empty.',
    );
    this.name = 'MalformedContentError';
  }
}

/** Waits `ms` milliseconds. Injectable so tests can assert retry behaviour without sleeping. */
export type Delay = (ms: number) => Promise<void>;

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;
const MAX_RETRY_AFTER_MS = 30_000;

// Only these failures can plausibly succeed on a retry: a transient server
// error, a dropped connection, or a rate limit that will lift. Everything
// else (bad requests, auth, permissions, conflicts, missing documents) is
// deterministic and retrying it only delays an actionable error.
const RETRYABLE_KINDS: ReadonlySet<ErrorKind> = new Set(['server', 'network', 'throttled']);

const realDelay: Delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isIdempotentGet(init?: RequestInit): boolean {
  return (init?.method ?? 'GET').toUpperCase() === 'GET';
}

function backoffMs(attempt: number): number {
  const exponential = BASE_DELAY_MS * 2 ** (attempt - 1);
  return exponential + Math.random() * BASE_DELAY_MS;
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;

  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

type AttemptResult =
  | { ok: true; response: Response }
  | { ok: false; error: DocsApiError; response?: Response };

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

  constructor(
    private readonly request: AuthenticatedFetch,
    private readonly delay: Delay = realDelay,
  ) {}

  setActionEnabled(action: string, enabled: boolean): void {
    this.actionEnabled.set(action, enabled);
  }

  isActionEnabled(action: string): boolean | undefined {
    return this.actionEnabled.get(action);
  }

  private async attempt(path: string, action: string, init?: RequestInit): Promise<AttemptResult> {
    let response: Response;
    try {
      response = await this.request(path, init);
    } catch (cause) {
      return {
        ok: false,
        error: new DocsApiError(
          'network',
          `Network error while contacting Docs: ${describeCause(cause)}`,
        ),
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        response,
        error: toDocsApiError(response, { action, actionEnabled: this.actionEnabled.get(action) }),
      };
    }

    return { ok: true, response };
  }

  private async send(path: string, action: string, init?: RequestInit): Promise<Response> {
    // Writes are never retried: a POST/PATCH/DELETE that may have landed on
    // the server is not something to guess about by sending it again.
    if (!isIdempotentGet(init)) {
      const result = await this.attempt(path, action, init);
      if (!result.ok) throw result.error;
      return result.response;
    }

    let lastError: DocsApiError | undefined;

    for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber += 1) {
      const result = await this.attempt(path, action, init);

      if (result.ok) {
        return result.response;
      }

      lastError = result.error;
      const canRetry = attemptNumber < MAX_ATTEMPTS && RETRYABLE_KINDS.has(result.error.kind);
      if (!canRetry) {
        throw result.error;
      }

      const delayMs =
        result.error.kind === 'throttled' && result.response
          ? (retryAfterMs(result.response) ?? backoffMs(attemptNumber))
          : backoffMs(attemptNumber);
      await this.delay(delayMs);
    }

    // Unreachable: the loop above always returns on success or throws once
    // retries are exhausted. This satisfies the function's return type.
    throw lastError ?? new DocsApiError('network', 'Retry loop exited without a result.');
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

    if (format === 'json' && !Array.isArray(payload.content)) {
      throw new MalformedContentError(id);
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
