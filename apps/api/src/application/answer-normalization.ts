import { protectedTextRanges } from "@videoq/domain/chat";

/** Remove terminal controls before interpreting Markdown/TeX, preserving actual prose. */
function cleanText(text: string, complete: boolean): string {
  let result = "";
  for (let i = 0; i < text.length;) {
    const code = text.charCodeAt(i);
    if (code === 0x1b || code === 0x9b || code === 0x9d) {
      const next = code === 0x1b ? text[i + 1] : code === 0x9b ? "[" : "]";
      const start = i + (code === 0x1b ? 2 : 1);
      if (next === "[") {
        let end = start;
        while (end < text.length && /[\x20-\x3f]/.test(text[end])) end++;
        if (end === text.length && !complete) break;
        i = end + (end < text.length && /[\x40-\x7e]/.test(text[end]) ? 1 : 0);
      } else if (next === "]") {
        // eslint-disable-next-line no-control-regex -- OSC terminates with BEL or ST, never printable prose.
        const end = /\x07|\x1b\\|\x9c/.exec(text.slice(start));
        if (!end) break;
        i = start + end.index + end[0].length;
      } else {
        if (!next && !complete) break;
        // Other two-character ANSI escapes; keep an ordinary character after ESC.
        i += next && /[@-_]/.test(next) ? 2 : 1;
      }
    } else {
      if ((code >= 0x20 && !(code >= 0x7f && code <= 0x9f)) || "\t\n\r".includes(text[i])) result += text[i];
      i++;
    }
  }
  return result;
}

/** Shared by final validation and incremental decoding. Never split code or math. */
export function normalizeAnswerTexts(texts: readonly string[], completed = texts.length): string[] {
  const cleaned = texts.map((text, index) => cleanText(text, index < completed));
  const normalized: string[] = [];
  let prefix = "";
  for (let i = 0; i < cleaned.length; i++) {
    let text = cleaned[i];
    if (prefix.trim() && text) {
      const whole = prefix + cleaned.slice(i).join("");
      const stableEnd = whole.length - (/[\\$`~ \t\r]*$/.exec(whole)?.[0].length ?? 0);
      // Delimiter lookahead and leading whitespace must settle before inserting a paragraph.
      if (i >= completed && (prefix.length > stableEnd || !text.trim())) break;
      const insideExpression = protectedTextRanges(whole).some(range => range.start < prefix.length && prefix.length < range.end);
      if (!insideExpression && text.trim()) {
        const trailing = /\n*$/.exec(prefix)?.[0].length ?? 0;
        const leading = /^\n*/.exec(text)?.[0].length ?? 0;
        text = "\n".repeat(Math.max(0, 2 - trailing - leading)) + text;
      }
    }
    normalized.push(text);
    prefix += text;
  }
  return normalized;
}
