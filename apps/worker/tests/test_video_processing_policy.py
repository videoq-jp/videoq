import pytest

from worker_python.domain.video_processing import (
    indexing_completion, processing_quota_allowed, processing_reservation_denied,
    processing_reservation_reused, processing_usage, require_transcription_fingerprint,
    transcription_completion, validate_processing_seconds, validate_transcript_clear,
)
from worker_python.use_cases.scene_splitting import split_scenes_best_effort


class Facts:
    def all(self, *terms): return all(terms)
    def any(self, *terms): return any(terms)
    def negate(self, term): return not term
    def choose(self, condition, yes, no): return yes if condition else no
    def literal(self, value): return value
    def number(self, value): return value
    def add(self, left, right): return left + right
    def subtract(self, left, right): return None if left is None else left - right
    def multiply(self, left, right): return None if left is None else left * right
    def at_most(self, left, right): return right is not None and left <= right
    def is_unlimited(self, value): return value is None


FACTS = Facts()


def test_processing_admission_retains_python_positive_comparison():
    for seconds in [0, -1, False]:
        with pytest.raises(ValueError, match='must be positive'):
            validate_processing_seconds(seconds)
    validate_processing_seconds(0.5)
    validate_processing_seconds(True)
    with pytest.raises(ValueError, match='Video 42 not found'):
        processing_reservation_reused(42, None)
    assert not processing_reservation_reused(42, 0)
    assert processing_reservation_reused(42, 1)
    assert processing_reservation_denied(1).limit_seconds == 60
    assert processing_reservation_denied(None).limit_seconds is None


def test_period_reset_discards_old_usage_and_resets_both_counters_together():
    reset = processing_usage(True, 999, 60, 27, 'old', 'now', FACTS)
    assert (reset.current_seconds, reset.next_seconds, reset.next_ai_answers, reset.next_period_start) == (0, 60, 0, 'now')
    live = processing_usage(False, 30, 30, 27, 'old', 'now', FACTS)
    assert (live.current_seconds, live.next_seconds, live.next_ai_answers, live.next_period_start) == (30, 60, 27, 'old')


def test_quota_equality_unlimited_and_over_quota_are_distinct():
    assert processing_quota_allowed(True, 30, 1, 30, FACTS)
    assert not processing_quota_allowed(True, 30, 1, 31, FACTS)
    assert processing_quota_allowed(True, 999, None, 60, FACTS)
    assert not processing_quota_allowed(False, 0, None, 1, FACTS)


@pytest.mark.parametrize('same,has_result,status,save,error', [
    (True, True, 'indexing', True, ''), (True, False, 'error', False, 'provider failed'),
    (False, True, 'completed', False, ''), (False, False, 'completed', False, ''),
])
def test_transcription_preserves_manual_edits_even_when_provider_failed(same, has_result, status, save, error):
    result = transcription_completion(True, same, has_result, 'provider failed', FACTS)
    assert (result.status, result.save_transcript, result.error, result.allowed) == (status, save, error, True)
    assert not transcription_completion(False, same, has_result, 'provider failed', FACTS).allowed


def test_index_completion_requires_the_same_transcript_file_and_indexing_state():
    assert indexing_completion(True, True, True, FACTS).allowed
    for facts in [(False, True, True), (True, False, True), (True, True, False)]:
        assert not indexing_completion(*facts, FACTS).allowed
    with pytest.raises(ValueError, match='fingerprint'):
        require_transcription_fingerprint(None)
    require_transcription_fingerprint('')
    validate_transcript_clear(True, ' \n')
    for matches, transcript in [(False, ''), (True, 'edited')]:
        with pytest.raises(ValueError, match='before clearing'):
            validate_transcript_clear(matches, transcript)


def test_best_effort_split_reports_only_recoverable_errors_and_keeps_original_text():
    error = RuntimeError('split failed')
    reports = []
    def fail(): raise error
    assert split_scenes_best_effort('original', fail, lambda _: False, lambda: reports.append('fallback')) == 'original'
    assert reports == ['fallback']
    reports.clear()
    with pytest.raises(RuntimeError) as caught:
        split_scenes_best_effort('original', fail, lambda _: True, lambda: reports.append('fallback'))
    assert caught.value is error
    assert reports == []
    assert split_scenes_best_effort('original', lambda: 'split', lambda _: True, lambda: reports.append('fallback')) == 'split'
    assert reports == []
