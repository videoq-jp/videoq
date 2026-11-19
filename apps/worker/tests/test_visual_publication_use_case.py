from unittest.mock import Mock

import pytest

from worker_python.use_cases.visual_publication import (
    PublicationResult, VisualChunk, VisualPublicationDependencies, finish_run, publish_chunk,
)


@pytest.fixture
def deps():
    return VisualPublicationDependencies(
        new_version=lambda: 'attempt', register=Mock(return_value=True),
        chunk_keys=lambda index, version: (f'{version}/{index}.bin', f'{version}/{index}.json'),
        manifest_keys=lambda version: (f'{version}/overview', f'{version}/manifest'),
        upload_pack=Mock(), upload_json=Mock(), delete=Mock(),
        publish_chunk=Mock(return_value=PublicationResult(True, 'attempt')),
        chunks=Mock(return_value=[VisualChunk(0, 1, 'selected')]),
        prepare_manifest=Mock(return_value=(b'overview', b'manifest')),
        publish_manifest=Mock(return_value=PublicationResult(True, 'attempt')),
        load_status=Mock(return_value='processing'),
    )


def test_registration_precedes_storage_and_rejection_never_uploads(deps):
    deps.register.return_value = False
    assert publish_chunk(0, object(), b'samples', 1, deps) is False
    deps.upload_pack.assert_not_called()
    deps.publish_chunk.assert_not_called()


def test_cleanup_failure_never_masks_the_upload_failure(deps):
    deps.upload_json.side_effect = ValueError('upload failed')
    deps.delete.side_effect = RuntimeError('cleanup failed')
    with pytest.raises(ValueError, match='upload failed'):
        publish_chunk(0, object(), b'samples', 1, deps)
    assert [call.args[0] for call in deps.delete.call_args_list] == ['attempt/0.bin', 'attempt/0.json']
    deps.publish_chunk.assert_not_called()


@pytest.mark.parametrize('accepted', [True, False])
def test_chunk_loser_cleans_only_its_attempt_and_preserves_current_outcome(deps, accepted):
    deps.publish_chunk.return_value = PublicationResult(accepted, 'winner')
    assert publish_chunk(0, object(), b'samples', 1, deps) is accepted
    assert [call.args[0] for call in deps.delete.call_args_list] == ['attempt/0.bin', 'attempt/0.json']


def test_ambiguous_publish_failure_does_not_delete_potentially_committed_objects(deps):
    deps.publish_chunk.side_effect = RuntimeError('response lost')
    with pytest.raises(RuntimeError, match='response lost'):
        publish_chunk(0, object(), b'samples', 1, deps)
    deps.delete.assert_not_called()


def test_manifest_is_built_from_committed_chunk_versions(deps):
    finish_run(deps)
    deps.prepare_manifest.assert_called_once_with([VisualChunk(0, 1, 'selected')])
    deps.register.assert_called_once_with('attempt', None)
    assert [call.args for call in deps.upload_json.call_args_list] == [
        ('attempt/overview', b'overview'), ('attempt/manifest', b'manifest'),
    ]
    deps.delete.assert_not_called()


@pytest.mark.parametrize('status, retry', [('processing', True), ('ready', False), (None, False)])
def test_manifest_waits_for_expired_registration_recovery(deps, status, retry):
    deps.register.return_value = False
    deps.load_status.return_value = status
    if retry:
        with pytest.raises(RuntimeError, match='object recovery'):
            finish_run(deps)
    else:
        finish_run(deps)
    deps.upload_json.assert_not_called()
    deps.publish_manifest.assert_not_called()


@pytest.mark.parametrize('accepted, status, retry', [
    (True, 'processing', False), (False, None, False), (False, 'processing', True),
])
def test_manifest_competition_or_deletion_and_retry(deps, accepted, status, retry):
    deps.publish_manifest.return_value = PublicationResult(accepted, 'winner')
    deps.load_status.return_value = status
    if retry:
        with pytest.raises(RuntimeError, match='did not complete'):
            finish_run(deps)
    else:
        finish_run(deps)
    assert [call.args[0] for call in deps.delete.call_args_list] == ['attempt/overview', 'attempt/manifest']
    if accepted:
        deps.load_status.assert_not_called()


def test_missing_run_never_builds_or_uploads_manifest(deps):
    deps.chunks.return_value = None
    finish_run(deps)
    deps.prepare_manifest.assert_not_called()
    deps.register.assert_not_called()
