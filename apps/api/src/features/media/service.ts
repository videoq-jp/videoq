import { isS3Storage, resolveFileUrl } from "../../integrations/media";
import { getMediaPathAccess } from "../../repositories/media-repository";
import type { Bindings } from "../../types/bindings";

function guessContentType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".srt")) return "application/x-subrip";
  if (lower.endsWith(".vtt")) return "text/vtt";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

export async function authorizeMediaPath(
  env: Bindings,
  path: string,
  opts: { userId?: string; shareSlug?: string },
): Promise<{ ok: true; objectKey: string } | { notFound: true } | { invalidShare: true }> {
  const access = await getMediaPathAccess(env, path, opts);
  if (access === null) return { invalidShare: true };
  if (!access) return { notFound: true };

  return { ok: true, objectKey: `media/${path}` };
}

export async function fallbackRedirectUrl(
  env: Bindings,
  path: string,
): Promise<string | null> {
  if (!isS3Storage(env)) return null;
  const url = await resolveFileUrl(env, path);
  return url && !url.startsWith("/") ? url : null;
}

/** R2 object → 200/206 Response。オブジェクト無しは null。 */
export async function buildR2MediaResponse(
  bucket: R2Bucket,
  objectKey: string,
  path: string,
  rangeHeader: string | undefined,
  rawHeaders: Headers,
): Promise<Response | null> {
  const obj = await bucket.get(
    objectKey,
    rangeHeader ? { range: rawHeaders } : undefined,
  );
  if (!obj) return null;

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  if (!headers.has("content-type")) {
    headers.set("Content-Type", guessContentType(path));
  }
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=0");

  const total = obj.size;
  const ranged = obj.range;
  if (ranged) {
    let start: number;
    let end = total - 1;
    if ("suffix" in ranged) {
      start = Math.max(0, total - ranged.suffix);
    } else {
      start = ranged.offset ?? 0;
      if (ranged.length !== undefined) {
        end = Math.min(total - 1, start + ranged.length - 1);
      }
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(total));
  return new Response(obj.body, { status: 200, headers });
}

export function mediaPathFromUrl(pathname: string): string {
  const prefix = "/api/media/";
  // createApp 経由は `/api/media/...`、feature 単体テストはマウント後の相対 path。
  const raw = pathname.startsWith(prefix)
    ? pathname.slice(prefix.length)
    : pathname.replace(/^\/+/, "");
  try {
    return decodeURIComponent(raw).replace(/^\/+/, "");
  } catch {
    // A malformed percent escape is an invalid media path, not a server error.
    return "";
  }
}
