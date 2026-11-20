from dataclasses import replace
from unittest.mock import Mock

import pytest

from worker_python.use_cases.scene_index import SceneSource, SceneIndexDependencies, execute_scene_index


def fixture():
    transcript = '\n'.join(f'{i+1}\n00:00:00,000 --> 00:00:01,000\ntext{i}\n' for i in range(21))
    source = SceneSource(1, 'owner', 'revision', 'video.mp4', transcript, 'indexing')
    deps = SceneIndexDependencies(
        load=Mock(return_value=source), finish=Mock(side_effect=['missing', 'completed']),
        split=Mock(return_value=transcript), new_run_id=lambda: 'run', scene_id=lambda run, index: f'{run}-{index}',
        start=Mock(return_value=True), embed=Mock(side_effect=lambda texts: [[1.0] for _ in texts]),
        stage=Mock(return_value=True), publish=Mock(return_value=True),
    )
    return source, deps


def test_bounded_batches_preserve_scene_identity_and_finish_only_after_publish():
    source, deps = fixture()
    assert execute_scene_index(1, deps, finish_indexing=True) == 21
    deps.start.assert_called_once_with(source, 'run', 21)
    assert [len(call.args[2]) for call in deps.stage.call_args_list] == [20, 1]
    rows = [row for call in deps.stage.call_args_list for row in call.args[2]]
    assert [row.id for row in rows] == [f'run-{i}' for i in range(21)]
    assert all(row.start_time == '00:00:00,000' and row.end_time == '00:00:01,000' for row in rows)
    assert deps.finish.call_count == 2


def test_embedding_count_mismatch_cannot_publish_partial_index():
    _, deps = fixture()
    deps.embed.side_effect = None
    deps.embed.return_value = []
    with pytest.raises(ValueError):
        execute_scene_index(1, deps)
    deps.stage.assert_not_called()
    deps.publish.assert_not_called()


def test_stale_revision_never_publishes_or_finishes():
    _, deps = fixture()
    deps.stage.return_value = False
    with pytest.raises(RuntimeError, match='changed during'):
        execute_scene_index(1, deps)
    deps.publish.assert_not_called()
    deps.finish.assert_not_called()


def test_pending_delivery_does_not_regenerate_embeddings():
    _, deps = fixture()
    deps.finish.side_effect = ['pending']
    with pytest.raises(RuntimeError, match='pending'):
        execute_scene_index(1, deps, finish_indexing=True)
    deps.split.assert_not_called()
    deps.embed.assert_not_called()
    deps.start.assert_not_called()


@pytest.mark.parametrize('invalid_source', [True, False])
def test_invalid_source_or_grouped_subtitles_never_start_an_index_run(invalid_source):
    source, deps = fixture()
    if invalid_source:
        deps.load.return_value = replace(source, transcript='not SRT')
    else:
        deps.split.return_value = 'not SRT'
    with pytest.raises(ValueError, match='no valid SRT scenes'):
        execute_scene_index(1, deps)
    if invalid_source:
        deps.split.assert_not_called()
    deps.start.assert_not_called()
    deps.embed.assert_not_called()
    deps.stage.assert_not_called()
    deps.publish.assert_not_called()
