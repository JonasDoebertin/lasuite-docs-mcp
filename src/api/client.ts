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
