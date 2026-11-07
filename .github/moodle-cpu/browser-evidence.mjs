import {AssertionError} from 'node:assert';

// Public CI evidence must never contain messages, selectors, URLs, HTTP bodies,
// credentials or raw stacks from the private browser. Only fixed error classes
// and a numeric location in the reviewed acceptance source are publishable.
export function browserFailure(error, sourceUrl) {
  const kind = error instanceof AssertionError ? 'assertion'
    : error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'error';
  const evidence = {kind};
  if (!(error instanceof Error) || typeof error.stack !== 'string') return evidence;
  const escaped = sourceUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const frame = new RegExp('(?:\\(|\\s)' + escaped + ':(\\d{1,6}):(\\d{1,6})\\)?$');
  for (const line of error.stack.split('\n')) {
    if (!/^\s+at /.test(line)) continue;
    const match = line.match(frame);
    if (!match) continue;
    const row = Number(match[1]), column = Number(match[2]);
    if (row > 0 && row <= 100_000 && column > 0 && column <= 100_000) {
      evidence.line = row;
      evidence.column = column;
      break;
    }
  }
  return evidence;
}
