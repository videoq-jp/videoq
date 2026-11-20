from contextlib import contextmanager
from unittest.mock import Mock

import pytest

from worker_python.domain.transcription_checkpoints import TranscriptionQuotaError
from worker_python.use_cases.segmented_transcription_start import QuotaRecovery, start_segmented_transcription


@pytest.mark.parametrize('accepted', [True, False])
def test_quota_recovery_is_scoped_and_stale_sources_are_not_saved(accepted):
    events = []
    @contextmanager
    def recovery():
        events.append('open')
        try:
            yield QuotaRecovery(lambda: accepted, lambda message: events.append(message))
        finally:
            events.append('close')
    start_segmented_transcription(Mock(side_effect=TranscriptionQuotaError('quota detail')), recovery)
    assert events == (['open', 'quota detail', 'close'] if accepted else ['open', 'close'])


def test_success_does_not_open_recovery_and_unrelated_errors_propagate():
    recovery = Mock()
    start_segmented_transcription(Mock(), recovery)
    with pytest.raises(RuntimeError, match='provider'):
        start_segmented_transcription(Mock(side_effect=RuntimeError('provider')), recovery)
    recovery.assert_not_called()
