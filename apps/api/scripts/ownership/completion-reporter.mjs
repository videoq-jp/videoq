import { writeFileSync } from 'node:fs';

/** JSON assertion reports alone omit unhandled errors and interruption state. */
export default class CompletionReporter {
  onTestRunEnd(_modules, unhandledErrors, reason) {
    writeFileSync(process.env.OWNERSHIP_COMPLETION_RECEIPT, JSON.stringify({ reason, unhandledErrors }));
  }
}
