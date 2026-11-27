import { iterSrtCues } from '@videoq/domain/transcript';

export interface SceneEncoding {
  encode(text: string): number[];
  /** Reject incomplete UTF-8, including a token ending inside a code point. */
  decodeStrict(tokens: number[]): string;
}
export interface SearchScene {
  index: number;
  startTime: string;
  endTime: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
}
export function parseSearchScenes(transcript: string): SearchScene[] {
  const scenes: SearchScene[] = [];
  const content = transcript.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (const block of content.split(/\n[ \t]*\n/)) {
    for (const cue of iterSrtCues(block)) {
      if (cue) scenes.push({ ...cue, index: Number(block.trim().split('\n', 1)[0]) });
    }
  }
  return scenes;
}

// Match Python round() on exact half milliseconds (ties to even).
function roundEven(value: number): number {
  const lower = Math.floor(value);
  return value - lower === 0.5 ? lower + lower % 2 : Math.round(value);
}
function formatTime(seconds: number): string {
  const ms = roundEven(Math.max(seconds, 0) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function scenesToSrt(scenes: readonly Pick<SearchScene, 'startTime' | 'endTime' | 'text'>[]): string {
  return scenes.map((s, i) => `${i + 1}\n${s.startTime} --> ${s.endTime}\n${s.text}\n`).join('\n');
}

/** Multidimensional Otsu criterion; strict > preserves the first boundary on ties. */
export function otsuBoundary(vectors: readonly number[][], start: number, end: number): number {
  const count = end - start + 1;
  if (count < 2) return 0;
  const dimensions = vectors[start].length;
  const total = Array<number>(dimensions).fill(0);
  for (let i = start; i <= end; i++) for (let d = 0; d < dimensions; d++) total[d] += vectors[i][d];
  const prefix = Array<number>(dimensions).fill(0);
  let best = 1, maximum = -1;
  for (let tau = 1; tau < count; tau++) {
    let sum = 0;
    for (let d = 0; d < dimensions; d++) {
      prefix[d] += vectors[start + tau - 1][d];
      const difference = prefix[d] * count - tau * total[d];
      sum += difference * difference;
    }
    const criterion = sum / (tau * (count - tau));
    if (criterion > maximum) { maximum = criterion; best = tau; }
  }
  return best;
}

export type SceneSplitEffect = { kind: 'embed'; texts: string[] } | { kind: 'boundary'; start: number; end: number; texts: string[] };

/** Iterative port of the Python splitter; no runtime, storage or provider dependency. */
export function* planSearchScenes(transcript: string, encoding: SceneEncoding, maxTokens = 512, externalBoundary = false): Generator<SceneSplitEffect, string, number | number[][]> {
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error('maxTokens must be positive');
  const raw = parseSearchScenes(transcript);
  if (!raw.length) return '';
  // Python splitlines() also recognizes the Unicode record separators.
  // eslint-disable-next-line no-control-regex
  const texts = raw.map(s => s.text.split(/\r\n|[\n\r\v\f\u001c-\u001e\u0085\u2028\u2029]/u).join(' '));
  const prefix = [0];
  const long = new Map<number, Pick<SearchScene, 'startTime' | 'endTime' | 'text'>[]>();
  for (let i = 0; i < texts.length; i++) {
    const tokens = encoding.encode(texts[i]);
    prefix.push(prefix.at(-1)! + tokens.length);
    if (tokens.length <= maxTokens) continue;
    const chunks: Pick<SearchScene, 'startTime' | 'endTime' | 'text'>[] = [];
    for (let start = 0; start < tokens.length;) {
      let end = Math.min(start + maxTokens, tokens.length), text: string | undefined;
      while (end > start) {
        try { text = encoding.decodeStrict(tokens.slice(start, end)); }
        catch { text = undefined; }
        if (text !== undefined && encoding.encode(text.trim()).length <= maxTokens) break;
        end--;
      }
      if (end <= start || text === undefined) throw new Error('maxTokens is too small to preserve this text');
      const time = (offset: number) => raw[i].startSeconds + (raw[i].endSeconds - raw[i].startSeconds) * offset / tokens.length;
      chunks.push({ startTime: formatTime(time(start)), endTime: formatTime(time(end)), text });
      start = end;
    }
    long.set(i, chunks);
  }
  let vectors: number[][] | undefined;
  const scenes: Pick<SearchScene, 'startTime' | 'endTime' | 'text'>[] = [];
  const pending: [number, number][] = [[0, texts.length - 1]];
  while (pending.length) {
    const [start, end] = pending.pop()!;
    const tokens = prefix[end + 1] - prefix[start];
    if (start === end && tokens > maxTokens) { scenes.push(...long.get(start)!); continue; }
    if (tokens <= maxTokens && (start === end || encoding.encode(texts.slice(start, end + 1).join(' ')).length <= maxTokens)) {
      scenes.push({ startTime: raw[start].startTime, endTime: raw[end].endTime, text: texts.slice(start, end + 1).join(' ') });
      continue;
    }
    let split = end;
    if (end !== start + 1 && externalBoundary) {
      const boundary = (yield { kind: 'boundary', start, end, texts }) as number;
      if (!Number.isSafeInteger(boundary) || boundary < 1 || boundary >= end - start + 1) throw new Error('Invalid scene boundary');
      split = start + boundary;
    } else if (end !== start + 1) {
      if (!vectors) {
        vectors = (yield { kind: 'embed', texts }) as number[][];
        const dimensions = vectors[0]?.length;
        if (vectors.length !== texts.length || !dimensions || vectors.some(v => v.length !== dimensions || v.some(x => !Number.isFinite(x)))) {
          throw new Error('Invalid scene embeddings');
        }
        // Normalize in place: retaining a second full matrix doubles peak memory.
        for (const vector of vectors) {
          const norm = Math.max(Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)), 1e-12);
          for (let d = 0; d < vector.length; d++) vector[d] /= norm;
        }
      }
      split = start + otsuBoundary(vectors, start, end);
    }
    pending.push([split, end], [start, split - 1]);
  }
  return scenesToSrt(scenes);
}
