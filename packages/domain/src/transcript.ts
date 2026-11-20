interface SrtCue {
  startTime: string;
  startSeconds: number;
  endTime: string;
  endSeconds: number;
  text: string;
}

const TIMESTAMP = "[0-9]{2,}:[0-5][0-9]:[0-5][0-9][,.][0-9]{3}";
const TIMING_LINE = new RegExp(`^(${TIMESTAMP})\\s*-->\\s*(${TIMESTAMP})$`);

function timestampSeconds(timestamp: string): number {
  const [hours, minutes, seconds, millis] = timestamp.split(/[:,.]/).map(Number);
  const totalMillis = ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
  return Number.isSafeInteger(totalMillis) ? totalMillis / 1000 : NaN;
}

function parseCue(block: string): SrtCue | null {
  const lines = block.split("\n");
  if (lines.length < 3 || !/^[+-]?[0-9]+$/.test(lines[0].trim())) return null;
  const timing = TIMING_LINE.exec(lines[1].trim());
  if (!timing) return null;

  const startSeconds = timestampSeconds(timing[1]);
  const endSeconds = timestampSeconds(timing[2]);
  const text = lines.slice(2).join("\n").trim();
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)
    || endSeconds < startSeconds || !text) return null;
  return { startTime: timing[1], startSeconds, endTime: timing[2], endSeconds, text };
}

/** Null marks an invalid cue: writes reject it; readers can skip it. */
export function* iterSrtCues(value: string): Generator<SrtCue | null> {
  const content = value.replace(/\r\n?/g, "\n");
  let start = 0;
  for (const separator of content.matchAll(/\n[ \t]*\n/g)) {
    const block = content.slice(start, separator.index).trim();
    if (block) yield parseCue(block);
    start = separator.index + separator[0].length;
  }
  const last = content.slice(start).trim();
  if (last) yield parseCue(last);
}
