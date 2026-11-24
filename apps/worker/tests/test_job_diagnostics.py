import json
import logging
from unittest.mock import Mock, patch

import pytest
import psycopg

from worker_python import lambda_handler
from worker_python.job_execution import JobExecutionBusyError, JobIdentityConflictError
from worker_python.job_diagnostics import job_failure


@pytest.mark.parametrize('error,code,retryable', [
    (JobExecutionBusyError('private-token'), 'JOB_BUSY', True),
    (JobIdentityConflictError('private-token'), 'JOB_IDENTITY_CONFLICT', False),
    (TimeoutError('private-token'), 'DEADLINE_EXCEEDED', True),
    (psycopg.OperationalError('private-sql'), 'DATABASE_UNAVAILABLE', True),
    (RuntimeError('private-token'), 'WORKER_EXECUTION_FAILED', True),
])
def test_lambda_logs_failure_identity_without_private_diagnostics(caplog, error, code, retryable):
    message = {'type': 'delete_account_data', 'job_id': 'job-1', 'payload': {'user_id': 'private-owner'}}
    with (
        patch('worker_python.lambda_handler.ensure_secrets_loaded'),
        patch('worker_python.lambda_handler.validate_internal_persistence'),
        patch('worker_python.lambda_handler.claim_job_execution', side_effect=error),
        caplog.at_level(logging.INFO),
    ):
        result = lambda_handler.handler({'Records': [{'messageId': 'message-1', 'body': json.dumps(message),
                                                     'attributes': {'ApproximateReceiveCount': '3'}}]}, None)
    assert result == {'batchItemFailures': [{'itemIdentifier': 'message-1'}]}
    records = [json.loads(r.message) for r in caplog.records if r.message.startswith('{')]
    assert records[-1].items() >= {'event': 'background_job_retry', 'job_id': 'job-1', 'message_id': 'message-1',
                                 'error_code': code, 'retryable': retryable, 'stage': 'claim', 'attempts': 3}.items()
    assert records[-1]['duration_ms'] >= 0
    assert 'private-' not in caplog.text
    assert all(r.exc_info is None for r in caplog.records)


@pytest.mark.parametrize('status,code', [(429, 'PROVIDER_RATE_LIMITED'), (503, 'PROVIDER_UNAVAILABLE')])
def test_provider_errors_are_classified_without_logging_the_response(caplog, status, code):
    error = RuntimeError('private-token-and-signed-url')
    error.status_code = status
    with (
        patch('worker_python.lambda_handler.ensure_secrets_loaded'),
        patch('worker_python.lambda_handler.validate_internal_persistence'),
        patch('worker_python.lambda_handler.claim_job_execution', return_value='lease'),
        patch('worker_python.lambda_handler.get_task', return_value=Mock(side_effect=error)),
        patch('worker_python.lambda_handler.fail_job_execution'),
        caplog.at_level(logging.INFO),
    ):
        lambda_handler.handler({'Records': [{'messageId': 'message', 'body': json.dumps({
            'type': 'index_video_transcript', 'job_id': 'job', 'payload': {'video_id': 1}})}]}, None)
    record = json.loads(caplog.records[-1].message)
    assert record['error_code'] == code
    assert record['stage'] == 'execute'
    assert 'private-' not in caplog.text


@pytest.mark.parametrize('body', ['not-json-or-base64', json.dumps({'type': 'bad', 'job_id': 'job', 'payload': {}})])
def test_invalid_work_still_returns_partial_batch_failure(caplog, body):
    with (
        patch('worker_python.lambda_handler.ensure_secrets_loaded'),
        patch('worker_python.lambda_handler.validate_internal_persistence'),
        patch('worker_python.lambda_handler.claim_job_execution') as claim,
        caplog.at_level(logging.INFO),
    ):
        result = lambda_handler.handler({'Records': [{'messageId': 'message', 'body': body}]}, None)
    assert result['batchItemFailures'] == [{'itemIdentifier': 'message'}]
    claim.assert_not_called()
    record = json.loads(caplog.records[-1].message)
    assert record['error_code'] == 'INVALID_JOB'
    assert record['retryable'] is False


def test_unreadable_diagnostic_cannot_prevent_retry():
    class BrokenDiagnostic(Exception):
        @property
        def status_code(self):
            raise RuntimeError('private-token')
    assert job_failure(BrokenDiagnostic(), 'execute') == {
        'error_code': 'WORKER_EXECUTION_FAILED', 'retryable': True,
    }
