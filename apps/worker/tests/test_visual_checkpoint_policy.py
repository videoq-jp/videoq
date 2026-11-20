import pytest

from worker_python.domain.visual_checkpoints import (
    VisualRun, visual_chunk_window, visual_plan, visual_run_owns_source,
    visual_run_reusable, visual_sample_targets, visual_source_eligible,
)


@pytest.mark.parametrize('duration', [0, -1, float('nan'), float('inf'), 36000.001])
def test_duration_admission_precedes_invalid_index(duration):
    with pytest.raises(ValueError, match='10 hours'):
        visual_chunk_window(duration, -1)


def test_plan_rounds_partial_milliseconds_and_keeps_last_chunk():
    assert visual_plan(60.0001) == (60001, 2)
    assert visual_plan(36000) == (36000000, 600)
    assert visual_chunk_window(60.0001, 1) == (60, 60.0001)


@pytest.mark.parametrize('index', [-1, 1, 0.0, True])
def test_chunk_index_is_an_exact_integer_within_duration(index):
    with pytest.raises(ValueError, match='chunk index'):
        visual_chunk_window(60, index)


def test_sampling_targets_are_unique_across_boundaries_and_bounded():
    duration = 9289.617
    targets = []
    for index in range(visual_plan(duration)[1]):
        start, end = visual_chunk_window(duration, index)
        chunk = visual_sample_targets(duration, start, end)
        assert all(start <= target < end for target in chunk)
        targets.extend(chunk)
    assert len(targets) == len(set(targets)) == 240
    assert visual_sample_targets(61, 0, 60) == list(range(0, 60, 5))
    assert visual_sample_targets(61, 60, 61) == [60]


def test_ready_runs_are_reusable_but_replaced_sources_are_fenced():
    run = VisualRun(42, 'run', 'file', 60000, 1, 'ready')
    assert visual_run_reusable(run, 'file')
    assert not visual_run_reusable(run, 'new-file')
    assert not visual_run_reusable(None, 'file')
    assert visual_source_eligible('file', 'file', 'uploaded')
    assert not visual_source_eligible('file', 'file', 'youtube')
    assert visual_run_owns_source(run, 'run', 'file', 'file')
    assert not visual_run_owns_source(run, 'old-run', 'file', 'file')
    assert not visual_run_owns_source(run, 'run', 'file', 'new-file')
