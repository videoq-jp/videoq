from unittest.mock import Mock

import pytest

from worker_python.use_cases.account_deletion import (
    AccountDeletionDependencies, execute_account_deletion, execute_leased_account_deletion,
)


@pytest.mark.parametrize('failed_step', range(6))
def test_failure_stops_before_later_resources_and_identity(failed_step):
    calls = []
    failure = RuntimeError('retry')

    def operation(index):
        def run(user_id):
            calls.append((index, user_id))
            if index == failed_step:
                raise failure
        return run

    deps = AccountDeletionDependencies(*(operation(i) for i in range(6)))
    with pytest.raises(RuntimeError) as result:
        execute_account_deletion('owner', deps)
    assert result.value is failure
    assert calls == [(i, 'owner') for i in range(failed_step + 1)]


def test_lease_loss_prevents_the_next_deletion_step():
    renew = Mock(side_effect=[True, False])
    step = Mock(return_value='progress')
    with pytest.raises(RuntimeError, match='lease'):
        execute_leased_account_deletion(renew=renew, step=step)
    step.assert_called_once()


def test_incomplete_budget_is_retryable_and_terminal_completion_stops():
    step = Mock(return_value='progress')
    with pytest.raises(RuntimeError, match='budget'):
        execute_leased_account_deletion(renew=lambda: True, step=step, max_steps=2)
    assert step.call_count == 2
    step = Mock(return_value='completed')
    execute_leased_account_deletion(renew=lambda: True, step=step)
    step.assert_called_once()
