import { AwsClient } from "aws4fetch";
import type { Bindings } from "../types/bindings";
import { deadlineSignal } from "../lib/request-timeout";
import { stripTrailingSlashes } from "../lib/url";

const S3_OPERATION_TIMEOUT_MS = 10_000;

/**
 * メディア共通基盤。
 * - USE_S3_STORAGE=true: S3 互換（本番 R2 / ローカル Garage）の presigned GET/PUT + Head/Delete
 * - USE_S3_STORAGE=false: VIDEO_BUCKET + `/api/media/`（multipart）
 *
 * オブジェクトキーは `media/<file_key>`。
 */

/** `"true"` のときのみ S3 API で署名する。 */
export function isS3Storage(env: Bindings): boolean {
  return (env.USE_S3_STORAGE ?? "").toLowerCase() === "true";
}

function useBucketBinding(env: Bindings): boolean {
  return (env.RUNTIME !== "node" && env.ENVIRONMENT === "production") || !isS3Storage(env);
}

function videoBucket(env: Bindings): R2Bucket {
  if (!env.VIDEO_BUCKET) throw new Error("Video bucket binding is not configured");
  return env.VIDEO_BUCKET;
}

// RFC3986: encodeURIComponent が残す ! ' ( ) * も % エンコードする。
function encodeRfc3986Segment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function requireS3Config(
  env: Bindings,
  opts: { /** false → Head/Delete 用（compose 内は garage:3900 など） */ public?: boolean } = {},
): {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
  region: string;
} {
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const publicEndpoint = env.R2_S3_ENDPOINT;
  const bucket = env.R2_BUCKET_NAME;
  if (!accessKeyId || !secretAccessKey || !publicEndpoint || !bucket) {
    throw new Error("S3/R2 credentials are not configured (R2_* / Garage)");
  }
  // 署名 URL はブラウザ到達可能な公開 endpoint。サーバー側 ops は INTERNAL があればそちら。
  const usePublic = opts.public !== false;
  const endpoint = stripTrailingSlashes(
    usePublic
      ? publicEndpoint
      : env.R2_S3_INTERNAL_ENDPOINT || publicEndpoint
  );
  // R2 は "auto"、ローカル Garage は "garage"、AWS S3 はバケットのリージョン。
  const region = (env.R2_S3_REGION || env.AWS_REGION || "auto").trim() || "auto";
  return {
    accessKeyId,
    secretAccessKey,
    endpoint,
    bucket,
    region,
  };
}

function s3Client(
  env: Bindings,
  opts: { public?: boolean } = {},
): { aws: AwsClient; endpoint: string; bucket: string } {
  const cfg = requireS3Config(env, opts);
  return {
    aws: new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      region: cfg.region,
      service: "s3",
    }),
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
  };
}

/** Path-style object URL: {endpoint}/{bucket}/media/{key} */
function objectUrl(endpoint: string, bucket: string, fileKey: string): URL {
  const normalizedKey = fileKey.replace(/\\/g, "/").replace(/^\/+/, "");
  const encodedPath = [bucket, "media", ...normalizedKey.split("/")]
    .map(encodeRfc3986Segment)
    .join("/");
  return new URL(`${endpoint}/${encodedPath}`);
}

async function presignR2Get(env: Bindings, fileKey: string): Promise<string> {
  const { aws, endpoint, bucket } = s3Client(env);
  const url = objectUrl(endpoint, bucket, fileKey);
  url.searchParams.set("X-Amz-Expires", "3600");
  const signed = await aws.sign(new Request(url, { method: "GET" }), {
    aws: { signQuery: true },
  });
  return signed.url;
}

/**
 * 設定に応じて署名 URL または API 配信 URL を返す。
 * 空→null / http(s)→そのまま /
 * USE_S3 → S3 presigned / それ以外 → `/api/media/{key}`（相対。FE が絶対化）。
 */
export async function resolveFileUrl(
  env: Bindings,
  fileKey: string | null,
): Promise<string | null> {
  if (!fileKey) return null;
  if (fileKey.startsWith("http://") || fileKey.startsWith("https://")) {
    return fileKey;
  }
  if (!isS3Storage(env)) {
    return `/api/media/${fileKey.replace(/^\/+/, "")}`;
  }
  try {
    return await presignR2Get(env, fileKey);
  } catch (e) {
    console.error(
      JSON.stringify({
        level: "error",
        error: "resolveFileUrl failed",
        message: e instanceof Error ? e.message : String(e),
      }),
    );
    return null;
  }
}

/** R2 / Garage の `media/` 配下に置くオブジェクトキー。 */
function r2ObjectKey(fileKey: string): string {
  const normalized = fileKey.replace(/\\/g, "/").replace(/^\/+/, "");
  return `media/${normalized}`;
}

/**
 * アップロード用 presigned PUT URL。
 * Content-Type と Content-Length を署名ヘッダに含める。
 * クライアントは申告したファイルそのものを PUT しなければ署名検証に失敗する。
 */
export async function presignR2Put(
  env: Bindings,
  fileKey: string,
  contentType: string,
  contentLength: number,
): Promise<string> {
  const { aws, endpoint, bucket } = s3Client(env);
  const url = objectUrl(endpoint, bucket, fileKey);
  url.searchParams.set("X-Amz-Expires", "3600");
  const signed = await aws.sign(
    new Request(url, {
      method: "PUT",
      headers: {
        "content-length": String(contentLength),
        "content-type": contentType,
      },
    }),
    { aws: { signQuery: true, allHeaders: true } },
  );
  return signed.url;
}

export async function presignR2UploadPart(
  env: Bindings, fileKey: string, uploadId: string, partNumber: number,
  contentType: string, contentLength: number,
): Promise<string> {
  const { aws, endpoint, bucket } = s3Client(env, { public: true });
  const url = objectUrl(endpoint, bucket, fileKey);
  url.searchParams.set("uploadId", uploadId);
  url.searchParams.set("partNumber", String(partNumber));
  url.searchParams.set("X-Amz-Expires", "3600");
  const signed = await aws.sign(new Request(url, {
    method: "PUT",
    headers: { "content-type": contentType, "content-length": String(contentLength) },
  }), { aws: { signQuery: true, allHeaders: true } });
  return signed.url;
}

// S3/Garage in local and on-prem deployments. Workers production uses its R2 binding.
async function multipartS3Request(
  env: Bindings, fileKey: string, query: Record<string, string>,
  init: RequestInit,
): Promise<Response> {
  const { aws, endpoint, bucket } = s3Client(env, { public: false });
  const url = objectUrl(endpoint, bucket, fileKey);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const signed = await aws.sign(new Request(url, init));
  const response = await fetch(signed, { signal: deadlineSignal(S3_OPERATION_TIMEOUT_MS) });
  if (!response.ok && !(init.method === "DELETE" && response.status === 404)) {
    await response.body?.cancel();
    throw new Error(`S3 multipart ${init.method} failed: ${response.status}`);
  }
  return response;
}

async function multipartXml(response: Response): Promise<string> {
  // Control responses are small; never buffer an unbounded storage response.
  const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) throw new Error("Empty S3 multipart response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 64 * 1024) throw new Error("S3 multipart response is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(body);
}

export async function createR2MultipartUpload(
  env: Bindings, fileKey: string, contentType: string,
): Promise<string> {
  if (useBucketBinding(env)) {
    const upload = await videoBucket(env).createMultipartUpload(r2ObjectKey(fileKey), {
      httpMetadata: { contentType },
    });
    return upload.uploadId;
  }
  const response = await multipartS3Request(env, fileKey, { uploads: "" }, {
    method: "POST", headers: { "content-type": contentType },
  });
  const xml = await multipartXml(response);
  const uploadId = xml.match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  if (!uploadId) throw new Error("S3 multipart upload ID is missing");
  // Decode only the entities present in the original XML, exactly once.
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return uploadId.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => entities[entity]);
}

export async function completeR2MultipartUpload(
  env: Bindings, fileKey: string, uploadId: string, parts: { partNumber: number; etag: string }[],
): Promise<void> {
  if (useBucketBinding(env)) {
    await videoBucket(env).resumeMultipartUpload(r2ObjectKey(fileKey), uploadId).complete(parts);
    return;
  }
  // ETags are validated as hexadecimal before reaching this integration.
  const xml = `<CompleteMultipartUpload>${parts.map(part => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${part.etag}"</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
  const response = await multipartS3Request(env, fileKey, { uploadId }, {
    method: "POST", headers: { "content-type": "application/xml" }, body: xml,
  });
  const result = await multipartXml(response);
  // S3 can return an embedded error even with HTTP 200.
  if (!result.includes("<CompleteMultipartUploadResult") || result.includes("<Error>")) {
    throw new Error("S3 multipart completion failed");
  }
}

export async function abortR2MultipartUpload(env: Bindings, fileKey: string, uploadId: string): Promise<void> {
  if (useBucketBinding(env)) {
    // R2 abort is idempotent, including after completion or a prior abort.
    await videoBucket(env).resumeMultipartUpload(r2ObjectKey(fileKey), uploadId).abort();
    return;
  }
  const response = await multipartS3Request(env, fileKey, { uploadId }, { method: "DELETE" });
  await response.body?.cancel();
}

/**
 * オブジェクトサイズ（bytes）。USE_S3 時は S3 HeadObject、それ以外は VIDEO_BUCKET.head。
 */
export async function getR2ObjectSize(
  env: Bindings,
  fileKey: string,
): Promise<number | null> {
  // Production Workers can reach R2 directly through the binding. Keep the
  // signed HTTP path for local/on-prem storage, where a binding is not the source
  // of truth used by presigned browser uploads.
  if (useBucketBinding(env)) {
    const obj = await videoBucket(env).head(r2ObjectKey(fileKey));
    return obj ? obj.size : null;
  }
  if (isS3Storage(env)) {
    const { aws, endpoint, bucket } = s3Client(env, { public: false });
    const url = objectUrl(endpoint, bucket, fileKey);
    const signed = await aws.sign(new Request(url, { method: "HEAD" }));
    const res = await fetch(signed, {
      signal: deadlineSignal(S3_OPERATION_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`S3 HeadObject failed: ${res.status}`);
    }
    const len = res.headers.get("content-length");
    return len != null ? Number(len) : null;
  }
  const obj = await videoBucket(env).head(r2ObjectKey(fileKey));
  return obj ? obj.size : null;
}

/** オブジェクト削除。USE_S3 時は S3 DeleteObject。 */
export async function deleteR2Object(env: Bindings, fileKey: string): Promise<void> {
  if (useBucketBinding(env)) {
    await videoBucket(env).delete(r2ObjectKey(fileKey));
    return;
  }
  if (isS3Storage(env)) {
    const { aws, endpoint, bucket } = s3Client(env, { public: false });
    const url = objectUrl(endpoint, bucket, fileKey);
    const signed = await aws.sign(new Request(url, { method: "DELETE" }));
    const res = await fetch(signed, {
      signal: deadlineSignal(S3_OPERATION_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 DeleteObject failed: ${res.status}`);
    }
    return;
  }
  await videoBucket(env).delete(r2ObjectKey(fileKey));
}

/** Server-only bounded reads. Never forward object URLs/credentials to a model. */
export async function deleteVisualChunks(env: Bindings, fileKey: string): Promise<void> {
  const prefix = r2ObjectKey(`${fileKey}.visual-v2/`);
  // Delete from the beginning each time: partial failures remain retryable and
  // no cursor can skip objects when the preceding page has just been removed.
  if (useBucketBinding(env)) {
    for (;;) {
      const page = await videoBucket(env).list({ prefix, limit: 100 });
      if (!page.objects.length) return;
      await videoBucket(env).delete(page.objects.map(object => object.key));
    }
  }
  const { aws, endpoint, bucket } = s3Client(env, { public: false });
  for (;;) {
    const url = new URL(`${endpoint}/${encodeURIComponent(bucket)}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("max-keys", "100");
    url.searchParams.set("encoding-type", "url");
    const request = await aws.sign(new Request(url));
    const response = await fetch(request, { signal: deadlineSignal(S3_OPERATION_TIMEOUT_MS) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`S3 ListObjects failed: ${response.status}`); }
    const xml = await multipartXml(response);
    const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map(match => decodeURIComponent(match[1]));
    if (!keys.length) return;
    for (const key of keys) {
      if (!key.startsWith(prefix)) throw new Error("Invalid visual cleanup key");
      await deleteR2Object(env, key.slice("media/".length));
    }
  }
}

/** Server-only bounded reads. Never forward object URLs/credentials to a model. */
export async function readMediaBytes(
  env: Bindings, fileKey: string, maxBytes: number, signal?: AbortSignal,
): Promise<Uint8Array | null> {
  signal?.throwIfAborted();
  let body: ReadableStream<Uint8Array>;
  let size: number;
  if (useBucketBinding(env)) {
    const object = await videoBucket(env).get(r2ObjectKey(fileKey));
    if (!object) return null;
    body = object.body as ReadableStream<Uint8Array>;
    size = object.size;
  } else {
    const { aws, endpoint, bucket } = s3Client(env, { public: false });
    const signed = await aws.sign(new Request(objectUrl(endpoint, bucket, fileKey)));
    const response = await fetch(signed, { signal: deadlineSignal(S3_OPERATION_TIMEOUT_MS, signal) });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`S3 GetObject failed: ${response.status}`);
    }
    body = response.body as ReadableStream<Uint8Array>;
    size = Number(response.headers.get("content-length") ?? 0);
  }
  if (size > maxBytes) {
    await body.cancel();
    throw new Error("Media object exceeds the read limit");
  }
  return readBoundedBody(body, maxBytes, signal);
}

/** Exact, version-pinned ranges for dense frame packs. Never fetch the full pack. */
export async function readMediaRange(
  env: Bindings, fileKey: string, offset: number, length: number,
  signal?: AbortSignal, etag?: string,
): Promise<{ bytes: Uint8Array; etag: string; size: number } | null> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length)
    || length <= 0 || length > 4 * 1024 * 1024 || !Number.isSafeInteger(offset + length)) {
    throw new Error("Invalid media range");
  }
  const requestSignal = deadlineSignal(S3_OPERATION_TIMEOUT_MS, signal);
  requestSignal.throwIfAborted();
  let body: ReadableStream<Uint8Array>;
  let size: number;
  let currentEtag: string;
  let validRange: boolean;
  if (useBucketBinding(env)) {
    const onlyIf = new Headers(etag ? { "if-match": etag } : {});
    const object = await videoBucket(env).get(r2ObjectKey(fileKey), { range: { offset, length }, onlyIf });
    if (!object || !("body" in object)) return null;
    body = object.body as ReadableStream<Uint8Array>;
    size = object.size;
    currentEtag = object.httpEtag;
    validRange = !!object.range && "offset" in object.range
      && object.range.offset === offset && object.range.length === length;
  } else {
    const { aws, endpoint, bucket } = s3Client(env, { public: false });
    const headers = new Headers({ Range: `bytes=${offset}-${offset + length - 1}` });
    if (etag) headers.set("If-Match", etag);
    const signed = await aws.sign(new Request(objectUrl(endpoint, bucket, fileKey), { headers }));
    const response = await fetch(signed, { signal: requestSignal });
    if (response.status === 404 || response.status === 412) { await response.body?.cancel(); return null; }
    if (response.status !== 206 || !response.body) {
      await response.body?.cancel();
      throw new Error(`S3 ranged GetObject failed: ${response.status}`);
    }
    body = response.body as ReadableStream<Uint8Array>;
    currentEtag = response.headers.get("etag") ?? "";
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    size = match ? Number(match[3]) : NaN;
    validRange = !!match && Number(match[1]) === offset && Number(match[2]) === offset + length - 1;
  }
  if (!validRange || !Number.isSafeInteger(size) || size < offset + length || !currentEtag || (etag && etag !== currentEtag)) {
    await body.cancel();
    throw new Error("Invalid or changed media range");
  }
  const bytes = await readBoundedBody(body, length, requestSignal);
  if (bytes.length !== length) throw new Error("Incomplete media range");
  return { bytes, etag: currentEtag, size };
}

async function readBoundedBody(body: ReadableStream<Uint8Array>, maxBytes: number, signal?: AbortSignal) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("Media object exceeds the read limit");
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** ローカル VIDEO_BUCKET へ保存（multipart / USE_S3=false 用）。 */
export async function putMediaObject(
  env: Bindings,
  fileKey: string,
  body: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
  contentType: string,
): Promise<void> {
  await videoBucket(env).put(r2ObjectKey(fileKey), body, {
    httpMetadata: { contentType },
  });
}
