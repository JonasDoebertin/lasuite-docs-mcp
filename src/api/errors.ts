export type ErrorKind =
  | 'unauthenticated'
  | 'action_disabled'
  | 'forbidden'
  | 'not_found'
  | 'throttled'
  | 'conflict'
  | 'bad_request'
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

  if (status >= 400 && status < 500) {
    return new DocsApiError(
      'bad_request',
      `Docs rejected the request as invalid (HTTP ${status}).`,
      status,
    );
  }

  return new DocsApiError('server', `Docs returned HTTP ${status}.`, status);
}
