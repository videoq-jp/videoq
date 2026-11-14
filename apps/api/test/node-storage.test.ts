import { afterEach, describe, expect, it, vi } from "vitest";
import { abortR2MultipartUpload, completeR2MultipartUpload, createR2MultipartUpload,
  deleteR2Object, getR2ObjectSize, readMediaBytes, readMediaRange } from "../src/integrations/media";
import type { Bindings } from "../src/types/bindings";

const env = { RUNTIME: "node", ENVIRONMENT: "production", USE_S3_STORAGE: "true",
  R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test", R2_BUCKET_NAME: "media",
  R2_S3_ENDPOINT: "https://public-storage.example.edu", R2_S3_INTERNAL_ENDPOINT: "http://garage:3900",
} as Bindings;
afterEach(() => vi.unstubAllGlobals());

describe("production Node storage without an R2 binding", () => {
  it("escapes opaque part ETags without inserting XML elements",async()=>{
    const tag="part<&>opaque";let body="";
    vi.stubGlobal("fetch",async(request:Request)=>{body=await request.text();return new Response("<CompleteMultipartUploadResult></CompleteMultipartUploadResult>");});
    await completeR2MultipartUpload(env,"video.mp4","upload",[{partNumber:1,etag:tag}]);
    expect(body).toContain('<ETag>"part&lt;&amp;&gt;opaque"</ETag>');expect(body).not.toContain(tag);
  });
  it("uses the internal S3 endpoint for object control and bounded reads", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (request: Request) => {
      requests.push(request);
      expect(new URL(request.url).origin).toBe("http://garage:3900");
      if (request.method === "HEAD") return new Response(null, { headers: { "Content-Length": "3" } });
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      if (request.headers.has("range")) return new Response(new Uint8Array([1, 2, 3]), {
        status: 206, headers: { "Content-Range": "bytes 10-12/100", ETag: '"v1"' },
      });
      return new Response(new Uint8Array([1, 2, 3]));
    });
    expect(await getR2ObjectSize(env, "videos/a.mp4")).toBe(3);
    await deleteR2Object(env, "videos/a.mp4");
    expect(await readMediaBytes(env, "videos/a.mp4", 10)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await readMediaRange(env, "videos/pack", 10, 3, undefined, '"v1"')).toMatchObject({ size: 100 });
    expect(requests).toHaveLength(4);
  });
  it("starts, completes and aborts multipart uploads through S3 in production", async () => {
    vi.stubGlobal("fetch", async (request: Request) => {
      const url = new URL(request.url);
      expect(url.hostname).toBe("garage");
      if (url.searchParams.has("uploads")) return new Response("<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>");
      expect(url.searchParams.get("uploadId")).toBe("upload-1");
      return new Response(request.method === "DELETE" ? null : "<CompleteMultipartUploadResult></CompleteMultipartUploadResult>");
    });
    expect(await createR2MultipartUpload(env, "videos/a.mp4", "video/mp4")).toBe("upload-1");
    await completeR2MultipartUpload(env, "videos/a.mp4", "upload-1", [{ partNumber: 1, etag: "a".repeat(32) }]);
    await abortR2MultipartUpload(env, "videos/a.mp4", "upload-1");
  });
});
