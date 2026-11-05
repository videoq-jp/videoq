import { describe, expect, it } from "vitest";
import { playbackCueHint } from "../src/features/lti/playback-context";
const transcript = '1\n00:00:00,000 --> 00:00:08,000\nLMS\n\n2\n00:00:08,000 --> 00:00:16,000\nVideoQ\n\n3\n00:00:16,000 --> 00:00:24,000\nLTI';
describe("LTI playback target", () => {
  it("identifies only the current cue and uses half-open boundaries", () => {
    expect(playbackCueHint(transcript, 10)).toContain('00:00:08,000〜00:00:16,000');
    expect(playbackCueHint(transcript, 8)).not.toContain('00:00:00,000〜');
    expect(playbackCueHint(transcript, 16)).toContain('00:00:16,000〜00:00:24,000');
  });
  it("does not assert a scene outside the subtitles or when unavailable", () => {
    expect(playbackCueHint(transcript, 30)).toContain('特定できていません');
    expect(playbackCueHint(null, 10)).toContain('特定できていません');
  });
});
