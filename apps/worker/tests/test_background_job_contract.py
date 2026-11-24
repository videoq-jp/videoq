"""The real Python execution entry point consumes the same wire cases as TS."""
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from worker_python.job_execution import _payload_sha256
from worker_python.use_cases.job_execution import execute_job, JobExecutionDependencies

CASES = json.loads((Path(__file__).parents[3] / 'packages/domain/test/fixtures/background-jobs.json').read_text())


@pytest.mark.parametrize('case', CASES, ids=lambda case: case['name'])
def test_shared_background_job_contract(case):
    claim = Mock(return_value=None)
    task = Mock()
    deps = JobExecutionDependencies(
        claim=claim, task=task, complete=Mock(), fail=Mock(),
        internal_persistence=lambda: False, worker_group=lambda: '', report=Mock(),
    )
    if not case['accepted']:
        with pytest.raises((ValueError, TypeError)):
            execute_job(case['message'], deps)
        claim.assert_not_called()
        return

    execute_job(case['message'], deps)
    execute_job(case['message'], deps)
    assert claim.call_count == 2
    for call in claim.call_args_list:
        job_id, kind, payload = call.args
        assert job_id == case['message']['job_id']
        canonical = json.dumps({'payload': payload, 'type': kind}, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        assert canonical == case['canonical']
        assert _payload_sha256(kind, payload) == case['sha256']
    task.assert_not_called()
