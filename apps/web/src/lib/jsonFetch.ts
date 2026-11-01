import i18n from '@/i18n/config';
import { ApiError } from './api-error';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const transientStatuses = new Set([502, 503, 504, 520, 521, 522, 523, 524]);

export class ApiResponseError extends ApiError {
  readonly status: number;

  constructor(status: number) {
    super(i18n.t('common.messages.connectionFailed'), 'INVALID_API_RESPONSE');
    this.name = 'ApiResponseError';
    this.status = status;
  }
}

function isJson(response: Response): boolean {
  const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  return mediaType === 'application/json' || Boolean(mediaType?.endsWith('+json'));
}

function waitForRetry(signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, 500);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

/** JSON transports must not interpret an edge/proxy HTML page as application data. */
export async function fetchJsonResponse(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchFn: FetchFn = fetch,
): Promise<Response> {
  const request = input instanceof Request ? input : undefined;
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const signal = init?.signal ?? request?.signal;
  let response = await fetchFn(input, init);
  if (!isJson(response) && transientStatuses.has(response.status) && method === 'GET') {
    // Retry a read once; never replay login, uploads, payments or other writes.
    await response.body?.cancel();
    await waitForRetry(signal);
    response = await fetchFn(input, init);
  }
  if (response.status !== 204 && !isJson(response)) {
    await response.body?.cancel();
    // Keep the HTTP status for session rejection handling. Never expose HTML,
    // URLs, cookies or an upstream diagnostic page in the error message.
    throw new ApiResponseError(response.status);
  }
  return response;
}
