from dataclasses import dataclass
from unittest.mock import Mock

import pytest
from worker_python.use_cases.segmented_transcription import ChunkDependencies, execute_chunk


class NoAudio(Exception):
    pass


@dataclass
class Run:
    completed: bool = False
    chunk_count: int = 3
    chunk_seconds: int = 30
    duration_ms: int = 65000
    transcription_language: str | None = 'ja'


def fixture(**overrides):
    run = Run()
    callbacks = dict(
        load=Mock(return_value=run), state=Mock(return_value=(True, False)),
        transcribe=Mock(return_value=[{'text': 'Hello'}]), save=Mock(return_value=True),
        dispatch=Mock(), reject_no_audio=Mock(), check_audio=Mock(), record_failure=Mock(),
        no_audio_error=NoAudio,
    )
    callbacks.update(overrides)
    return run, ChunkDependencies(**callbacks)


def test_last_interval_is_bounded_and_checkpoint_precedes_delivery():
    run, deps = fixture()
    events = []
    deps.save.side_effect = lambda *args: events.append('save') or True
    deps.dispatch.side_effect = lambda *args: events.append('dispatch')
    execute_chunk(1, 'run', 2, deps)
    deps.transcribe.assert_called_once_with(run, 2, 60, 5)
    assert events == ['save', 'dispatch']


def test_saved_chunk_retries_delivery_without_a_provider_call():
    run, deps = fixture(state=Mock(return_value=(True, True)))
    execute_chunk(1, 'run', 0, deps)
    deps.transcribe.assert_not_called()
    deps.save.assert_not_called()
    deps.dispatch.assert_called_once_with(run, 0)


@pytest.mark.parametrize('state', [(False, False), (False, True)])
def test_stale_chunk_never_calls_provider_or_delivers(state):
    _, deps = fixture(state=Mock(return_value=state))
    execute_chunk(1, 'run', 0, deps)
    deps.transcribe.assert_not_called()
    deps.dispatch.assert_not_called()


def test_stale_save_stops_delivery():
    _, deps = fixture(save=Mock(return_value=False))
    execute_chunk(1, 'run', 0, deps)
    deps.dispatch.assert_not_called()


def test_delivery_failure_records_failure_and_propagates():
    error = RuntimeError('queue down')
    run, deps = fixture(dispatch=Mock(side_effect=error))
    with pytest.raises(RuntimeError, match='queue down'):
        execute_chunk(1, 'run', 0, deps)
    deps.record_failure.assert_called_once_with(run, 0, 'queue down')


def test_provider_no_audio_only_terminates_when_source_has_no_audio():
    run, deps = fixture(transcribe=Mock(side_effect=NoAudio('silent')), check_audio=Mock(side_effect=NoAudio()))
    execute_chunk(1, 'run', 0, deps)
    deps.reject_no_audio.assert_called_once_with(run, 0, 'silent')
    deps.save.assert_not_called()
    deps.dispatch.assert_not_called()


def test_interval_no_audio_is_retryable_when_source_has_audio():
    run, deps = fixture(transcribe=Mock(side_effect=NoAudio('interval')))
    with pytest.raises(NoAudio):
        execute_chunk(1, 'run', 0, deps)
    deps.record_failure.assert_called_once_with(run, 0, 'interval')
    deps.reject_no_audio.assert_not_called()


def test_failure_recording_does_not_hide_original_provider_failure():
    _, deps = fixture(transcribe=Mock(side_effect=RuntimeError('provider')), record_failure=Mock(side_effect=RuntimeError('database')))
    with pytest.raises(RuntimeError, match='provider'):
        execute_chunk(1, 'run', 0, deps)


@pytest.mark.parametrize('index', [-1, 3])
def test_invalid_index_is_rejected_before_any_work(index):
    _, deps = fixture()
    with pytest.raises(ValueError):
        execute_chunk(1, 'run', index, deps)
    deps.state.assert_not_called()
    deps.transcribe.assert_not_called()


def test_completed_run_never_calls_provider():
    _, deps = fixture(load=Mock(return_value=Run(completed=True)))
    execute_chunk(1, 'run', 0, deps)
    deps.state.assert_not_called()
    deps.transcribe.assert_not_called()


def plan_fixture():
    from worker_python.use_cases.segmented_transcription import PlanDependencies
    video = Mock(id=1, file_key='video', transcript_hash='revision')
    plan = Mock(duration_ms=65000, transcript_hash='revision', chunk_count=3)
    deps = PlanDependencies(
        queue_available=True, check_audio=Mock(), reject_no_audio=Mock(),
        load=Mock(return_value=plan), duration=Mock(return_value=100),
        initialize=Mock(return_value=plan), dispatch=Mock(), no_audio_error=NoAudio,
    )
    return video, plan, deps


def test_existing_plan_reuses_duration_without_probing_again():
    from worker_python.use_cases.segmented_transcription import start_plan
    video, plan, deps = plan_fixture()
    start_plan(video, deps)
    deps.duration.assert_not_called()
    deps.initialize.assert_called_once_with(video, 65)
    deps.dispatch.assert_called_once_with(plan)


def test_changed_source_uses_fresh_duration():
    from worker_python.use_cases.segmented_transcription import start_plan
    video, plan, deps = plan_fixture()
    plan.transcript_hash = 'old'
    start_plan(video, deps)
    deps.duration.assert_called_once_with(video)
    deps.initialize.assert_called_once_with(video, 100)


def test_plan_without_audio_does_not_reserve_or_dispatch():
    from worker_python.use_cases.segmented_transcription import start_plan
    video, _, deps = plan_fixture()
    deps.check_audio.side_effect = NoAudio('no audio')
    start_plan(video, deps)
    deps.reject_no_audio.assert_called_once_with(video, 'no audio')
    deps.initialize.assert_not_called()
    deps.dispatch.assert_not_called()


def test_plan_without_queue_does_not_probe_or_reserve():
    from dataclasses import replace
    from worker_python.use_cases.segmented_transcription import start_plan
    video, _, deps = plan_fixture()
    with pytest.raises(RuntimeError, match='SQS_QUEUE_URL'):
        start_plan(video, replace(deps, queue_available=False))
    deps.check_audio.assert_not_called()
    deps.initialize.assert_not_called()


def test_rejected_plan_does_not_dispatch():
    from worker_python.use_cases.segmented_transcription import start_plan
    video, _, deps = plan_fixture()
    deps.initialize.return_value = None
    start_plan(video, deps)
    deps.dispatch.assert_not_called()


@pytest.mark.parametrize('status', [None, 'error', 'processing'])
def test_finalization_does_not_handoff_incomplete_stale_or_empty_results(status):
    from worker_python.use_cases.segmented_transcription import FinalizationDependencies, finish_plan
    deps = FinalizationDependencies(commit=Mock(return_value=status), handoff=Mock(), start_visuals=Mock(), handoff_in_commit=False, visuals_enabled=True)
    finish_plan(Run(), deps)
    deps.handoff.assert_not_called()
    deps.start_visuals.assert_not_called()


@pytest.mark.parametrize('atomic_handoff', [False, True])
def test_finalization_delivers_after_commit_without_duplicating_atomic_outbox(atomic_handoff):
    from worker_python.use_cases.segmented_transcription import FinalizationDependencies, finish_plan
    events = []
    deps = FinalizationDependencies(
        commit=Mock(side_effect=lambda run: events.append('commit') or 'indexing'),
        handoff=Mock(side_effect=lambda run: events.append('handoff')),
        start_visuals=Mock(side_effect=lambda run: events.append('visuals')),
        handoff_in_commit=atomic_handoff, visuals_enabled=True,
    )
    finish_plan(Run(), deps)
    assert events == (['commit', 'visuals'] if atomic_handoff else ['commit', 'handoff', 'visuals'])


def test_failed_finalization_cannot_start_followup_work():
    from worker_python.use_cases.segmented_transcription import FinalizationDependencies, finish_plan
    deps = FinalizationDependencies(commit=Mock(side_effect=RuntimeError('commit')), handoff=Mock(), start_visuals=Mock(), handoff_in_commit=False, visuals_enabled=True)
    with pytest.raises(RuntimeError, match='commit'):
        finish_plan(Run(), deps)
    deps.handoff.assert_not_called()
    deps.start_visuals.assert_not_called()
