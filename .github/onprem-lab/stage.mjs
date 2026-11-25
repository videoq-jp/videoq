import {writeFileSync, renameSync} from 'node:fs';
// Fixed labels only: never include request bodies, credentials, URLs or error messages.
export async function labStage(label, operation, report = value => console.error(JSON.stringify(value))) {
  const started = performance.now();
  report({labStage: label, status: 'started'});
  try {
    const value = await operation();
    report({labStage: label, status: 'passed', elapsedMilliseconds: Math.round(performance.now() - started)});
    return value;
  } catch (error) {
    report({labStage: label, status: 'failed', elapsedMilliseconds: Math.round(performance.now() - started), timeout: error?.name === 'TimeoutError'});
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
