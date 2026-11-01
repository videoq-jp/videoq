import { parse, parseFragment } from 'parse5';

function text(node) {
  if (['script', 'style', 'template'].includes(node.tagName)) return '';
  if (node.nodeName === '#text') return node.value;
  return (node.childNodes ?? []).map(text).join('');
}
function byId(node, id) {
  if (node.attrs?.some(attribute => attribute.name === 'id' && attribute.value === id)) return node;
  for (const child of node.childNodes ?? []) {
    const found = byId(child, id);
    if (found) return found;
  }
}
// This is text inspection, not HTML sanitization or markup for reinsertion.
export function htmlText(html) { return text(parseFragment(html)); }
export function rootText(html) {
  const root = byId(parse(html), 'root');
  return root ? text(root) : '';
}
