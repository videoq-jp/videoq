"""Allowlisted job diagnostics: no exception text, payload, SQL or response bodies."""
import psycopg

from worker_python.job_execution import JobExecutionBusyError, JobIdentityConflictError


def job_failure(error: Exception, stage: str) -> dict:
    if stage in {'decode', 'validate'}:
        return {'error_code': 'INVALID_JOB', 'retryable': False}
    if isinstance(error, JobExecutionBusyError):
        return {'error_code': 'JOB_BUSY', 'retryable': True}
    if isinstance(error, JobIdentityConflictError):
        return {'error_code': 'JOB_IDENTITY_CONFLICT', 'retryable': False}
    if isinstance(error, TimeoutError):
        return {'error_code': 'DEADLINE_EXCEEDED', 'retryable': True}
    if isinstance(error, psycopg.OperationalError):
        return {'error_code': 'DATABASE_UNAVAILABLE', 'retryable': True}
    try:
        status = getattr(error, 'status_code', None)
        if type(status) is int and status == 429:
            return {'error_code': 'PROVIDER_RATE_LIMITED', 'retryable': True}
        if type(status) is int and 500 <= status <= 599:
            return {'error_code': 'PROVIDER_UNAVAILABLE', 'retryable': True}
    except Exception:
        pass  # A broken diagnostic accessor must not suppress partial batch failure.
    return {'error_code': 'WORKER_EXECUTION_FAILED', 'retryable': True}


def receive_attempts(value: object) -> int | None:
    if isinstance(value, str) and value.isascii() and value.isdigit() and len(value) <= 16:
        number = int(value)
        if 0 < number <= 2**53 - 1:
            return number
    return None
