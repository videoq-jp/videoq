/** Delimiter rules shared by streamed citation validation and saved-answer rendering. */
type MathDelimiter = { open: string; close: string; display: boolean };
type CodeDelimiter = { character: string; length: number; fenced: boolean };
export type ChatTextNode =
  | { type: "text"; value: string }
  | { type: "math"; value: string; display: boolean };
export type ChatTextContext = { previous: string; linePrefix: string };

/** Only the previous character and up to four characters of line indentation matter. */
export function advanceChatTextContext(context: ChatTextContext, text: string): ChatTextContext {
  const newline = text.lastIndexOf("\n");
  return {
    previous: text.at(-1) ?? context.previous,
    linePrefix: newline === -1 ? (context.linePrefix + text).slice(0, 4) : text.slice(newline + 1, newline + 5),
  };
}

const MATH_DELIMITERS: Record<string, MathDelimiter | undefined> = {
  "$$": { open: "$$", close: "$$", display: true },
  "\\[": { open: "\\[", close: "\\]", display: true },
  "\\(": { open: "\\(", close: "\\)", display: false },
};

function mathOpening(character: string, next: string, previous: string): MathDelimiter | null {
  const paired = MATH_DELIMITERS[character + next];
  if (paired) return paired;
  // Match existing inline TeX: whitespace after $ is allowed; $100 is currency.
  if (character === "$" && next && !/\d/.test(next) && !/[A-Za-z0-9\\]/.test(previous)) {
    return { open: "$", close: "$", display: false };
  }
  return null;
}

const inlineMathCanClose = (next: string): boolean => next !== "$" && !/[A-Za-z0-9]/.test(next);

function codeRunLength(text: string, start: number): number {
  const character = text[start];
  if (character !== "`" && character !== "~") return 0;
  let end = start + 1;
  while (text[end] === character) end++;
  return end - start;
}

function isCodeLineStart(text: string, index: number): boolean {
  let spaces = 0;
  for (let i = index - 1; i >= 0 && text[i] !== "\n"; i--) {
    if (text[i] !== " " || ++spaces > 3) return false;
  }
  return true;
}

function codeOpening(character: string, length: number, atLineStart: boolean): CodeDelimiter | null {
  const fenced = length >= 3 && atLineStart;
  return character === "`" || (character === "~" && fenced) ? { character, length, fenced } : null;
}

function codeRunCanClose(region: CodeDelimiter, character: string, length: number, atLineStart: boolean): boolean {
  return character === region.character && (region.fenced ? atLineStart && length >= region.length : length === region.length);
}

const isFenceSpace = (character: string): boolean => character === " " || character === "\t" || character === "\r";

function findCodeEnd(text: string, start: number, region: CodeDelimiter): number {
  for (let cursor = start; cursor < text.length;) {
    const length = codeRunLength(text, cursor);
    if (!length) { cursor++; continue; }
    if (codeRunCanClose(region, text[cursor], length, isCodeLineStart(text, cursor))) {
      let tail = cursor + length;
      if (region.fenced) while (isFenceSpace(text[tail])) tail++;
      if (!region.fenced || tail === text.length || text[tail] === "\n") return cursor + length;
    }
    cursor += length;
  }
  return -1;
}

function findMathEnd(text: string, start: number, delimiter: MathDelimiter): number {
  let braces = 0;
  for (let cursor = start; cursor < text.length; cursor++) {
    const character = text[cursor];
    if (delimiter.close === "$" && character === "\n") return -1;
    if (braces <= 0 && text.startsWith(delimiter.close, cursor)) {
      if (delimiter.close === "$" && (cursor === start || !inlineMathCanClose(text[cursor + 1] ?? ""))) return -1;
      return cursor;
    }
    if (character === "\\") {
      if (delimiter.close === "$" && text[cursor + 1] === "\n") return -1;
      cursor++;
    }
    else if (character === "{") braces++;
    else if (character === "}") braces--;
  }
  return -1;
}

/** Code stays literal; completed TeX is rendered, and unfinished TeX stays readable. */
export function parseChatText(text: string, context: ChatTextContext = { previous: "", linePrefix: "" }): ChatTextNode[] {
  const content = context.linePrefix + text;
  const nodes: ChatTextNode[] = [];
  let cursor = context.linePrefix.length;
  let textStart = cursor;
  while (cursor < content.length) {
    const character = content[cursor];
    const length = codeRunLength(content, cursor);
    if (length) {
      const code = codeOpening(character, length, isCodeLineStart(content, cursor));
      const end = code ? findCodeEnd(content, cursor + length, code) : cursor + length;
      cursor = end === -1 ? content.length : end;
      continue;
    }
    const previous = cursor === context.linePrefix.length ? context.previous : content[cursor - 1];
    const math = mathOpening(character, content[cursor + 1] ?? "", previous);
    if (math) {
      const start = cursor + math.open.length;
      const end = findMathEnd(content, start, math);
      if (end !== -1) {
        if (cursor > textStart) nodes.push({ type: "text", value: content.slice(textStart, cursor) });
        nodes.push({ type: "math", value: content.slice(start, end), display: math.display });
        cursor = textStart = end + math.close.length;
      } else cursor = start;
    } else cursor += character === "\\" && cursor + 1 < content.length ? 2 : 1;
  }
  if (textStart < content.length) nodes.push({ type: "text", value: content.slice(textStart) });
  return nodes;
}

/** Citation boundaries may not split a code or TeX expression, even across segments. */
export function protectedTextRanges(text: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let cursor = 0; cursor < text.length;) {
    const start = cursor;
    const length = codeRunLength(text, cursor);
    const code = length ? codeOpening(text[cursor], length, isCodeLineStart(text, cursor)) : null;
    const math = !code ? mathOpening(text[cursor], text[cursor + 1] ?? "", text[cursor - 1] ?? "") : null;
    if (code || math) {
      const close = code ? findCodeEnd(text, cursor + length, code)
        : findMathEnd(text, cursor + math!.open.length, math!);
      const end = close === -1 ? text.length + 1 : close + (math?.close.length ?? 0);
      ranges.push({ start, end });
      cursor = end;
    } else cursor += length || (text[cursor] === "\\" && cursor + 1 < text.length ? 2 : 1);
  }
  return ranges;
}
