import {writeFileSync, renameSync} from 'node:fs';
// Fixed labels only: never include request bodies, credentials, URLs or error messages.
export async function labStage(label, operation, report = value => console.error(JSON.stringify(value))) {
  const started = performance.now();
  const reportSafely = value => {
    try { report(value); } catch {
      // Diagnostic storage failure must not replace or reclassify request results.
      try { console.error(JSON.stringify({labStage: label, diagnosticStatus: 'failed'})); } catch {}
    }
  };
  reportSafely({labStage: label, status: 'started'});
  try {
    const value = await operation();
    reportSafely({labStage: label, status: 'passed', elapsedMilliseconds: Math.round(performance.now() - started)});
    return value;
  } catch (error) {
    reportSafely({labStage: label, status: 'failed', elapsedMilliseconds: Math.round(performance.now() - started), timeout: error?.name === 'TimeoutError'});
    throw error;
  }
}

export function stageReporter(path, mode) {
  const stages = [];
  return value => {
    const row = {mode, ...value};
    stages.push(row);
    writeFileSync(path + '.tmp', JSON.stringify({stages}), {mode: 0o600});
    renameSync(path + '.tmp', path);
    console.error(JSON.stringify(row));
  };
}

// Observe only fixed event categories. Return the original body for unchanged assertions.
export async function readSseBody(response, started, report) {
  const elapsed = () => Math.round(performance.now() - started);
  const counters = Object.fromEntries(['text_delta', 'citation', 'source', 'searching', 'search_completed', 'tool_progress', 'done', 'error', 'other'].map(key => [key, 0]));
  const toolStatusCounters = {running: 0, complete: 0, error: 0};
  const progress = {labStage: 'chat.stream', status: 'progress', headersElapsedMilliseconds: elapsed(), firstEventElapsedMilliseconds: null, lastEventElapsedMilliseconds: null, eventCount: 0};
  const emit = () => {
    try { report({...progress, eventCounters: {...counters}, toolStatusCounters: {...toolStatusCounters}}); }
    catch { try { console.error(JSON.stringify({labStage: 'chat.stream', diagnosticStatus: 'failed'})); } catch {} }
  };
  emit();
  let body = '', pending = '';
  const decoder = new TextDecoder();
  const observe = line => {
    if (!line.startsWith('data: ')) return;
    let event;
    try { event = JSON.parse(line.slice(6)); } catch { /* Parsing remains the caller's assertion. */ }
    const category = typeof event?.type === 'string' && Object.hasOwn(counters, event.type) ? event.type : 'other';
    counters[category]++;
    if (category === 'tool_progress' && typeof event.status === 'string' && Object.hasOwn(toolStatusCounters, event.status)) toolStatusCounters[event.status]++;
    progress.eventCount++;
    progress.firstEventElapsedMilliseconds ??= elapsed();
    progress.lastEventElapsedMilliseconds = elapsed();
    // Bound diagnostic I/O; always retain the last observation on exit, including abort.
    if (progress.eventCount === 1 || progress.eventCount % 64 === 0) emit();
  };
  const consume = text => {
    body += text; pending += text;
    let newline;
    while ((newline = pending.indexOf('\n')) !== -1) {
      observe(pending.slice(0, newline)); pending = pending.slice(newline + 1);
    }
  };
  if (!response.body) return '';
  const reader = response.body.getReader();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      consume(decoder.decode(value, {stream: true}));
    }
    consume(decoder.decode());
    if (pending) observe(pending);
    return body;
  } finally {
    emit();
    try { reader.releaseLock(); } catch { /* Preserve the original stream result. */ }
  }
}
