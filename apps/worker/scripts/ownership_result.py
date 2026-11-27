"""Fail closed unless a reviewed mutant witness breaks a clean baseline test."""
import re

ENVIRONMENT_FAILURE = re.compile(
    r'timed?\s+out|\btimeout(?:error)?\b|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|'
    r'connection (?:refused|terminated|closed)|server closed the connection|'
    r'out of memory|worker (?:exited|crashed)|socket hang up', re.I)


def evaluate_run(*, mode, returncode, report, transformed, completion, witness=None, baseline=None):
    cases = report.findall('.//testcase') if report is not None else []
    failed = [c for c in cases if c.find('failure') is not None]
    errors = [c for c in cases if c.find('error') is not None]
    skipped = [c for c in cases if c.find('skipped') is not None]
    identity = lambda case: case.get('classname', '') + '::' + case.get('name', '')
    keys = sorted(identity(c) for c in cases)
    result = dict(status='invalid-run', reason='', testKeys=keys,
                  failedTests=[identity(c) for c in failed], failed=len(failed), skipped=len(skipped),
                  passed=len(cases)-len(failed)-len(errors)-len(skipped))

    def invalid(reason):
        return {**result, 'reason': reason}

    if returncode not in (0, 1):
        return invalid('abnormal-process-exit')
    if not completion or completion.get('exitCode') != returncode or completion.get('collectionErrors') != [] or completion.get('unhandledErrors') != []:
        return invalid('missing-or-unclean-completion')
    if not transformed or transformed.get('sites', 0) <= 0 or transformed.get('mode') != ('baseline' if mode == 'recovery' else mode):
        return invalid('missing-or-wrong-transform')
    if not cases or len(set(keys)) != len(keys) or skipped or errors:
        return invalid('missing-duplicate-skipped-or-error-tests')
    # JUnit tracebacks also contain source excerpts (e.g. timeout=30). Inspect
    # exception lines, not source code that merely configures a timeout.
    if any(ENVIRONMENT_FAILURE.search(f.get('message', '') + '\n' + '\n'.join(
               line for line in (f.text or '').splitlines()
               if re.match(r'^(?:E\s+|[\w.]+(?:Error|Exception):|Caused by:)', line)))
           for c in failed for f in c.findall('failure')):
        return invalid('environment-failure')
    if baseline and keys != baseline['testKeys']:
        return invalid('baseline-test-set-changed')
    if mode in ('baseline', 'recovery'):
        return {**result, 'status': 'passed', 'reason': 'clean-baseline'} if returncode == 0 and not failed else invalid('baseline-failed')
    if not baseline or baseline['status'] != 'passed':
        return invalid('missing-clean-baseline')
    if returncode == 0:
        return {**result, 'status': 'survived', 'reason': 'mutant-did-not-break-contract'} if not failed else invalid('inconsistent-exit')
    if witness and any(identity(c) == witness['test'] and
                       any(f.get('message', '').split('\n')[0] == witness['error'] for f in c.findall('failure'))
                       for c in failed):
        return {**result, 'status': 'detected', 'reason': 'reviewed-failure-witness', 'witness': witness}
    return invalid('expected-failure-witness-missing')
