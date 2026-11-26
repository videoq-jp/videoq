"""Exercise a selected consumer revision, including successful completion/replay."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1]) / 'apps/worker'))
if sys.argv[2] == '--produce':
    from worker_python.domain.jobs import build_job_message, parse_job_message
    vectors = json.loads((Path(sys.argv[1]) / 'packages/domain/test/fixtures/background-jobs.json').read_text())
    for vector in vectors:
        if vector['accepted']:
            message = parse_job_message(vector['message'])
            vector['message'] = build_job_message(message['type'], message['payload'], job_id=message['job_id'], new_id=lambda: 'unused')
    print(json.dumps(vectors))
    sys.exit(0)
from worker_python.job_execution import _payload_sha256
from worker_python.use_cases.job_execution import execute_job, JobExecutionDependencies

vectors = json.loads(Path(sys.argv[2]).read_text())
for vector in vectors:
    state = {'claims': 0, 'effects': 0, 'complete': False}

    def claim(job_id, kind, payload):
        state['claims'] += 1
        assert job_id == vector['message']['job_id']
        canonical = json.dumps({'payload': payload, 'type': kind}, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        assert canonical == vector['canonical']
        assert _payload_sha256(kind, payload) == vector['sha256']
        return None if state['complete'] else 'synthetic-lease'

    def task(**_kwargs):
        state['effects'] += 1

    def complete(*_args):
        state['complete'] = True

    def fail(*_args):
        raise AssertionError('Unexpected failed delivery')

    deps = JobExecutionDependencies(claim=claim, task=lambda _kind: task, complete=complete,
        fail=fail, internal_persistence=lambda: False, worker_group=lambda: '', report=lambda *_args: None)
    if not vector['accepted']:
        try:
            execute_job(vector['message'], deps)
        except (TypeError, ValueError):
            pass
        else:
            raise AssertionError('Invalid message accepted')
        assert state['claims'] == 0
    else:
        execute_job(vector['message'], deps)
        execute_job(vector['message'], deps)
        assert state == {'claims': 2, 'effects': 1, 'complete': True}
print(json.dumps({'cases': len(vectors), 'passed': True}))
