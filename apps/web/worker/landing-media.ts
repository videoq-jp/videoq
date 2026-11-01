// The rendered product demos stay below 16 MB. Workers Assets does not guarantee Range support;
// provide it explicitly so viewers can seek before the full video loads.
const MAX_DEMO_BYTES = 16 * 1024 * 1024;

export async function serveLandingVideo(request: Request, assets: Fetcher): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  const headers = new Headers(request.headers);
  headers.delete('Range');
  headers.set('Accept-Encoding', 'identity');
  const original = await assets.fetch(new Request(request, { headers }));
  if (original.status !== 200) return original;
  const responseHeaders = new Headers(original.headers);
  responseHeaders.set('Accept-Ranges', 'bytes');
  const rangeHeader = request.headers.get('Range');
  const ifRange = request.headers.get('If-Range');
  if (request.method === 'HEAD' || !rangeHeader || (ifRange && ifRange !== original.headers.get('ETag') && ifRange !== original.headers.get('Last-Modified'))) {
    return new Response(original.body, { headers: responseHeaders });
  }

  // Bound the read even if an asset is replaced with a larger file later.
  const reader = (original.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return new Response(null, { status: 500 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_DEMO_BYTES) {
        await reader.cancel();
        return new Response(null, { status: 500 });
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const range = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
  let start = Number(range?.[1] || 0);
  let end = range?.[2] ? Number(range[2]) : size - 1;
  if (range && !range[1] && range[2]) {
    start = Math.max(0, size - Number(range[2]));
    end = size - 1;
  }
  if (!range || (!range[1] && !range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  end = Math.min(end, size - 1);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  responseHeaders.delete('Content-Encoding');
  responseHeaders.set('Content-Length', String(end - start + 1));
  responseHeaders.set('Content-Range', `bytes ${start}-${end}/${size}`);
  return new Response(bytes.slice(start, end + 1), { status: 206, headers: responseHeaders });
}
