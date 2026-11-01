import { videosInputSchemas } from "../../../packages/trpc/src/inputs/videos";
import { describe, it, expect, vi } from "vitest";
import { MAX_VIDEO_UPLOAD_BYTES, multipartPartSize } from "@videoq/trpc/video-upload";
import {
  buildPendingUploadFileKey,
  fileExtension,
  isAllowedExtension,
  isAllowedContentType,
  parseReservedBytesFromFileKey,
  unsupportedTypeMessage,
} from "../src/lib/upload";
import {
  deleteR2Object,
  getR2ObjectSize,
  isS3Storage,
  presignR2Put,
  presignR2UploadPart,
  resolveFileUrl,
} from "../src/integrations/media";
// os.path.splitext(x)[1].lower() 相当（/tmp/drf_probe5.py で実 Python と一致確認）。
describe("fileExtension — os.path.splitext parity", () => {
  const cases: [string, string][] = [
    ["clip.mp4", ".mp4"],
    ["doc.pdf", ".pdf"],
    ["noext", ""],
    ["a.tar.gz", ".gz"],
    ["VID.MP4", ".mp4"],
    [".mp4", ""], // 隠しファイル: 拡張子なし
    ["archive.", "."],
    ["movie .mov", ".mov"],
    ["dir/sub/x.webm", ".webm"],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(fileExtension(input)).toBe(expected);
    });
  }
});

describe("upload allow-lists + message", () => {
  it("extensions", () => {
    expect(isAllowedExtension(".mp4")).toBe(true);
    expect(isAllowedExtension(".pdf")).toBe(false);
    expect(isAllowedExtension("")).toBe(false);
  });
  it("mimetypes", () => {
    expect(isAllowedContentType("video/mp4")).toBe(true);
    expect(isAllowedContentType("application/pdf")).toBe(false);
  });
  it.each(["video/matroska", "video/x-matroska"])("accepts MKV uploads with %s", contentType => {
    expect(isAllowedExtension(fileExtension("recording.MKV"))).toBe(true);
    expect(isAllowedContentType(contentType)).toBe(true);
  });
  it("unsupported message uses sorted list", () => {
    expect(unsupportedTypeMessage(".pdf")).toBe(
      "Unsupported file type: '.pdf'. Allowed types: .3gp, .avi, .m4v, .mkv, .mov, .mp4, .mpeg, .mpg, .webm",
    );
  });
});

describe("USE_S3_STORAGE / resolveFileUrl", () => {
  it("isS3Storage は true 文字列のみ", () => {
    expect(isS3Storage({ USE_S3_STORAGE: "true" } as never)).toBe(true);
    expect(isS3Storage({ USE_S3_STORAGE: "false" } as never)).toBe(false);
    expect(isS3Storage({} as never)).toBe(false);
  });

  it("local では /api/media/ 相対パス", async () => {
    await expect(
      resolveFileUrl({ USE_S3_STORAGE: "false" } as never, "videos/1/a.mp4"),
    ).resolves.toBe("/api/media/videos/1/a.mp4");
  });

  it("productionの内部head/deleteはR2 bindingを使う", async () => {
    const head = vi.fn().mockResolvedValue({ size: 42 });
    const remove = vi.fn().mockResolvedValue(undefined);
    const env = {
      ENVIRONMENT: "production",
      USE_S3_STORAGE: "true",
      VIDEO_BUCKET: { head, delete: remove },
    } as never;

    await expect(getR2ObjectSize(env, "videos/1/a.mp4")).resolves.toBe(42);
    await deleteR2Object(env, "videos/1/a.mp4");

    expect(head).toHaveBeenCalledWith("media/videos/1/a.mp4");
    expect(remove).toHaveBeenCalledWith("media/videos/1/a.mp4");
  });
});

describe("pending upload file key（FR-Q3 予約埋め込み）", () => {
  it.each([1, 100 * 1024 ** 2, 45_160_000_000, MAX_VIDEO_UPLOAD_BYTES])("keeps %i bytes within R2's part limits", size => {
    const partSize = multipartPartSize(size);
    expect(Math.ceil(size / partSize)).toBeLessThanOrEqual(10_000);
    expect(partSize).toBeGreaterThanOrEqual(5 * 1024 ** 2);
    expect(partSize).toBeLessThanOrEqual(5 * 1024 ** 3);
  });
  it("signs a multipart ID, number, exact length and MIME type for the public endpoint", async () => {
    const signed = await presignR2UploadPart({
      R2_ACCESS_KEY_ID: "test", R2_SECRET_ACCESS_KEY: "test",
      R2_S3_ENDPOINT: "https://public.example.test", R2_S3_INTERNAL_ENDPOINT: "http://garage:3900",
      R2_BUCKET_NAME: "test", R2_S3_REGION: "garage",
    } as never, "videos/owner/test.mkv", "session+/=", 42, "video/matroska", 1024);
    const url = new URL(signed);
    expect(url.origin).toBe("https://public.example.test");
    expect(url.searchParams.get("uploadId")).toBe("session+/=");
    expect(url.searchParams.get("partNumber")).toBe("42");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
  });
  it("presigned PUT は申告サイズを署名対象にする", async () => {
    const signed = await presignR2Put(
      {
        R2_ACCESS_KEY_ID: "test-access-key",
        R2_SECRET_ACCESS_KEY: "test-secret-key",
        R2_S3_ENDPOINT: "https://objects.example.test",
        R2_BUCKET_NAME: "videoq-test",
        R2_S3_REGION: "auto",
      } as never,
      "videos/1/video_1_999.mp4",
      "video/mp4",
      999,
    );

    expect(new URL(signed).searchParams.get("X-Amz-SignedHeaders")).toContain(
      "content-length",
    );
  });

  it("build → parse で予約バイトが復元できる", () => {
    const key = buildPendingUploadFileKey(
      "00000000-0000-4000-8000-000000000007",
      1_048_576,
      ".mp4",
      1_700_000_000_000,
      "0123456789ab",
    );
    expect(key).toBe(
      "videos/00000000-0000-4000-8000-000000000007/video_1700000000000_0123456789ab_1048576.mp4",
    );
    expect(key.length).toBeLessThanOrEqual(100);
    expect(parseReservedBytesFromFileKey(key)).toBe(1_048_576);
  });

  it("同時刻・同サイズでも既定の nonce でキーが衝突しない", () => {
    const first = buildPendingUploadFileKey("7", 1024, ".mp4", 1_700_000_000_000);
    const second = buildPendingUploadFileKey("7", 1024, ".mp4", 1_700_000_000_000);

    expect(first).not.toBe(second);
    expect(parseReservedBytesFromFileKey(first)).toBe(1024);
    expect(parseReservedBytesFromFileKey(second)).toBe(1024);
  });

  it("nonce 導入前の予約付き key も解析できる", () => {
    expect(
      parseReservedBytesFromFileKey("videos/7/video_1700000000000_1048576.mp4"),
    ).toBe(1_048_576);
  });

  it("旧形式 key は null（解放は R2 head 頼み）", () => {
    expect(parseReservedBytesFromFileKey("videos/7/video_1700000000000.mp4")).toBeNull();
  });

});


describe('upload transcription language validation', () => {
  const input = { filename: 'clip.mp4', contentType: 'video/mp4', fileSize: 1, title: 'Clip' };
  it.each([undefined, 'ja', 'en', 'ko'])('accepts %s', transcriptionLanguage => {
    expect(videosInputSchemas['videos.requestUpload'].safeParse({ ...input, transcriptionLanguage }).success).toBe(true);
  });
  it.each(['auto', 'ja-JP', 'invalid', '', null])('rejects invalid language %s', transcriptionLanguage => {
    expect(videosInputSchemas['videos.requestUpload'].safeParse({ ...input, transcriptionLanguage }).success).toBe(false);
  });
});
