type IdReference =
  | { kind: "none"; excluded: number[] }
  | { kind: "unresolved"; excluded: number[] }
  | { kind: "selected"; ids: number[]; excluded: number[] };

/** Conservative lexical facts, separate from the planner's semantic interpretation.
 * Only an unambiguous ID list/correction establishes a scope here. Unsupported
 * alternatives/negations remain unresolved rather than selecting all mentions.
 */
export function inspectVideoIdReference(question: string): IdReference {
  let text = question.normalize("NFKC");
  // Quoted historical statements are context, not a new video request. Remove
  // only the quoted statement, so a later current selection is still inspected.
  text = text.replace(/(?:以前|過去|前の発言|引用|previously|earlier|quoted)[^「『"]*[「『"][^」』"]*[」』"]/gi, "");
  if ((/(?:動画\s*ID|video[_ ]?id)\s*(?:という用語|という言葉|の意味|とは|って何|mean)/i.test(text) || /what (?:is|does).*?video[_ ]?id/i.test(text))
    && !/(?:動画\s*ID|video[_ ]?ids?|^ID)\s*[:#=]?\s*[`"'「」『』“”‘’]*\s*[+-]?\d/i.test(text)) {
    return { kind: "none", excluded: [] };
  }
  text = text.replace(/[`"'「」『』“”‘’]/g, "");
  const label = /(?:動画\s*ID|video[_ ]?ids?|^ID)(?![a-z])/gi;
  const labels = [...text.matchAll(label)];
  if (!labels.length) return { kind: "none", excluded: [] };
  const ids: number[] = [], excluded: number[] = [];
  let unresolved = false;
  for (const [index, mention] of labels.entries()) {
    const start = mention.index + mention[0].length;
    const tail = text.slice(start, labels[index + 1]?.index);
    const numbers = tail.match(/^\s*[:#=]?\s*([+-]?\d+(?:\.\d+)?(?:\s*(?:[,、]|and|と|および)\s*[+-]?\d+(?:\.\d+)?)*)/i);
    if (!numbers) { unresolved = true; continue; }
    const values = numbers[1].split(/[,、]|and|と|および/i).map(id => Number(id.trim()));
    const suffix = tail.slice(numbers[0].length);
    const correction = suffix.match(/^\s*(?:ではなく|じゃなく)\s*([+-]?\d+(?:\.\d+)?)/);
    if (correction) { excluded.push(...values); ids.push(Number(correction[1])); }
    else if (/^\s*(?:ではなく|じゃなく|以外|を除く)/.test(suffix)) excluded.push(...values);
    else if (/\b(?:not|except|rather than|or)\b|(?:ではない|じゃない|または|除外|不要)/i.test(suffix)
      || /^\s*か\s*(?:$|[+-]?\d)/.test(suffix)
      || /\b(?:not|except)\s*$/i.test(text.slice(0, mention.index))) unresolved = true;
    else ids.push(...values);
  }
  const selected = [...new Set(ids.filter(id => !excluded.includes(id)))];
  if (unresolved || !selected.length) return { kind: "unresolved", excluded };
  return { kind: "selected", ids: selected, excluded };
}
