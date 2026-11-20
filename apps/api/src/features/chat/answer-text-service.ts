import { normalizeAnswerTexts } from "../../application/answer-normalization";
import type { ModelAnswer } from '@videoq/domain/chat';
import { StructuredAnswerError } from '../../application/answer-generation';

export interface AnswerTextDecoding {
  decodeComplete(text: string): ModelAnswer;
  decodePartial(text: string): unknown;
  decodeFinal(text: string): ModelAnswer;
}

/** Only complete JSON escapes are safe to expose from a partial string. */
function stableJsonPrefix(text: string): string {
  const escape = /(?:\\u[\da-fA-F]{0,3}|\\)$/.exec(text);
  if (!escape) return text;
  let slashes = 0;
  for (let i = escape.index - 1; i >= 0 && text[i] === "\\"; i--) slashes++;
  return slashes % 2 === 0 ? text.slice(0, escape.index) : text;
}

/** Injected JSON decoding with monotonic text only; final validation remains strict. */
export class AnswerTextService {
  constructor(private readonly deps: AnswerTextDecoding) {}
  private raw = "";
  private readonly emitted: string[] = [];
  private depth = 0;
  private inString = false;
  private escaped = false;
  private closedPrefix = "";
  private normalizedTexts: string[] = [];

  /** Only objects closed on the wire, never the SDK's repaired partial JSON. */
  completedSegments(): ModelAnswer["segments"] {
    if (!this.closedPrefix) return [];
    try {
      return this.deps.decodeComplete(this.closedPrefix + "]}").segments
        .slice(0, this.normalizedTexts.length)
        .map((segment, index) => ({ ...segment, text: this.normalizedTexts[index] }));
    } catch {
      throw new StructuredAnswerError("Invalid structured answer segment.");
    }
  }

  text(): string {
    return this.emitted.join("");
  }

  push(delta: string): Array<{ segmentIndex: number; text: string }> {
    const start = this.raw.length;
    this.raw += delta;
    if (this.raw.length > 256_000) throw new StructuredAnswerError("Structured answer exceeded size limit.");
    for (let i = start; i < this.raw.length; i++) {
      const c = this.raw[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') this.inString = false;
      } else if (c === '"') this.inString = true;
      else if (c === "{" || c === "[") this.depth++;
      else if (c === "}" || c === "]") {
        // root object → segments array → segment object
        if (c === "}" && this.depth === 3) this.closedPrefix = this.raw.slice(0, i + 1);
        this.depth--;
      }
    }
    let partial: unknown;
    try { partial = this.deps.decodePartial(stableJsonPrefix(this.raw)); } catch { return []; }
    const segments = (partial as { segments?: unknown[] } | null)?.segments;
    if (!Array.isArray(segments)) return [];
    const complete = this.depth === 0 && !this.inString;
    const closed = this.closedPrefix ? this.deps.decodeComplete(this.closedPrefix + "]}").segments.length : 0;
    const rawTexts: string[] = [];
    for (const segment of segments) {
      if (!segment || typeof segment !== "object" || !("text" in segment) || typeof segment.text !== "string") break;
      rawTexts.push(segment.text.replace(/[\uD800-\uDBFF]$/, ""));
    }
    this.normalizedTexts = normalizeAnswerTexts(rawTexts, complete ? rawTexts.length : closed);
    const out: Array<{ segmentIndex: number; text: string }> = [];
    this.normalizedTexts.forEach((text, segmentIndex) => {
      const previous = this.emitted[segmentIndex];
      if (!text.startsWith(previous ?? "")) throw new StructuredAnswerError("Structured answer changed an emitted prefix.");
      if (previous === undefined || text.length > previous.length) {
        out.push({ segmentIndex, text: text.slice(previous?.length ?? 0) });
        this.emitted[segmentIndex] = text;
      }
    });
    return out;
  }

  finish(): ModelAnswer {
    const answer = this.deps.decodeFinal(this.raw);
    if (answer.segments.length !== this.emitted.length
      || answer.segments.some((s, i) => s.text !== this.emitted[i])) {
      throw new StructuredAnswerError("Structured answer stream was incomplete.");
    }
    return answer;
  }
}
