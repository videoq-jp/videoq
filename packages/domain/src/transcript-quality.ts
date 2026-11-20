
/** Advisory signals on the returned excerpt, never an ASR confidence estimate. */
export function transcriptQuality(hit: { content: string; startTime: string; endTime: string }) {
  const seconds = (time: string) => {
    const match = /^(\d+):([0-5]\d):([0-5]\d)(?:[,.](\d{3}))?$/.exec(time);
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4] ?? 0) / 1000 : NaN;
  };
  const duration = seconds(hit.endTime) - seconds(hit.startTime);
  // Bound work even for legacy, manually edited or very large search chunks.
  const sample = hit.content.slice(0, 12_000);
  const normalized = sample.normalize("NFKC").toLowerCase().replace(/\d+/g, "#").replace(/[\p{P}\p{Z}\s]/gu, "");
  const grams = new Map<string, number>();
  const total = Math.max(0, normalized.length - 11);
  let peak = 0;
  for (let i = 0; i < total; i++) {
    const gram = normalized.slice(i, i + 12);
    const count = (grams.get(gram) ?? 0) + 1;
    grams.set(gram, count);
    peak = Math.max(peak, count);
  }
  const repetition = total ? (total - grams.size) / total : 0;
  const flags: string[] = [];
  if (Number.isFinite(duration) && duration >= 60) flags.push("coarse_timing");
  if (normalized.length >= 120 && repetition >= 0.45 && peak >= 4) flags.push("high_repetition");
  return {
    flags,
    interval_seconds: Number.isFinite(duration) && duration >= 0 ? duration : null,
    repeated_ngram_fraction: Math.round(repetition * 100) / 100,
    text_sampled: sample.length < hit.content.length,
    ...(flags.length ? { note: "Advisory only: repetition may be legitimate and long intervals may be grouped search scenes or legacy subtitles. Do not infer a precise event time from the interval, or trust repeated counts/names without corroboration. Read original cues or inspect images as appropriate; do not discard the transcript automatically." } : {}),
  };
}
