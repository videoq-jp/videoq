import { isLandingEventPayload } from '../src/lib/landingEvents';

const MAX_BYTES = 512;

export async function collectLandingEvent(request: Request, environment: string): Promise<Response> {
  const reply = (status: number) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
  if (environment !== 'production') return reply(204);
  if (request.method !== 'POST') return reply(405);
  if (request.headers.get('Origin') !== new URL(request.url).origin) return reply(403);
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') return reply(415);
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) return reply(413);
  const reader = (request.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return reply(400);
  try {
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        return reply(413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const payload: unknown = JSON.parse(text);
    if (!isLandingEventPayload(payload)) return reply(400);
    // Reuse Workers Logs; never log the request, cookies, IP, or arbitrary input.
    console.log({ kind: 'landing_funnel', version: 'student-v1', ...payload });
    return reply(204);
  } catch {
    return reply(400);
  } finally {
    reader.releaseLock();
  }
}
