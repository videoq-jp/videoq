import { youtubeVideoIdFromParts } from '@videoq/domain/youtube';
import { describe, it, expect } from "vitest";
import { extractYoutubeVideoId } from "../src/lib/youtube";

// 期待値は実 Python extract_youtube_video_id と一致（/tmp/yt_probe.py 済）。
describe("extractYoutubeVideoId", () => {
  const ID = "dQw4w9WgXcQ";
  const valid: [string, string][] = [
    [`https://www.youtube.com/watch?v=${ID}`, ID],
    [`https://youtu.be/${ID}`, ID],
    [`https://www.youtube.com/embed/${ID}`, ID],
    [`https://www.youtube.com/shorts/${ID}`, ID],
    [`http://m.youtube.com/watch?v=${ID}`, ID],
    [`  https://youtu.be/${ID}  `, ID], // trim
    ["https://www.youtube.com/watch?v=dQw4w9WgXc_", "dQw4w9WgXc_"], // - / _ 許容
  ];
  for (const [url, expected] of valid) {
    it(`valid: ${url.trim()}`, () => {
      expect(extractYoutubeVideoId(url)).toBe(expected);
    });
  }

  const invalid = [
    "https://www.youtube.com/watch?v=short", // 11桁でない
    "https://vimeo.com/12345", // ホスト不一致
    "notaurl", // URL でない
    "ftp://youtu.be/dQw4w9WgXcQ", // scheme 不可
    "https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ", // 偽装ホスト
  ];
  for (const url of invalid) {
    it(`invalid: ${url}`, () => {
      expect(extractYoutubeVideoId(url)).toBe(null);
    });
  }
});

it('handles long slash runs without an unbounded trailing-slash regex', () => {
  const id = 'abcdefghijk', padding = '/'.repeat(100000);
  expect(youtubeVideoIdFromParts({protocol:'https:',host:'youtu.be',pathname:'/'+id+padding+'suffix',videoQuery:null})).toBe(id);
  expect(youtubeVideoIdFromParts({protocol:'https:',host:'youtu.be',pathname:padding+id+'/',videoQuery:null})).toBe(id);
  expect(youtubeVideoIdFromParts({protocol:'https:',host:'youtube.com',pathname:'/embed/'+id+padding+'suffix',videoQuery:null})).toBe(id);
});
