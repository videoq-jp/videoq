/** Test HTTP stubs accept the same textual bodies the real JSON/form transports send. */
export function requestBodyText(body: RequestInit['body'] | undefined): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new TypeError('Expected a string or URLSearchParams request body');
}
