"""Manifest assembly uses plain records and injected sample/encoding capabilities."""
import json
from unittest.mock import Mock

import pytest

from worker_python.use_cases.visual_manifest import (
    VisualManifestDependencies, VisualManifestPlan, publication_payloads,
)
from worker_python.use_cases.visual_publication import VisualChunk


def encode(value):
    return json.dumps(value, separators=(',', ':')).encode()


def test_unready_chunks_are_rejected_before_reading_storage_or_encoding():
    read, serialize = Mock(), Mock()
    deps = VisualManifestDependencies(read, serialize, 1000, 60)
    with pytest.raises(RuntimeError, match='incomplete'):
        publication_payloads(VisualManifestPlan(1, 'run', 60_000, 2), [VisualChunk(0, 1, 'version')], deps)
    read.assert_not_called()
    serialize.assert_not_called()


def test_overview_thinning_retains_the_complete_manifest_and_selected_object_version():
    samples = [dict(timestamp_seconds=i * 5, jpeg_base64='x' * 120, offset=i * 100, length=100) for i in range(8)]
    read = Mock(return_value=samples)
    payload, manifest_bytes = publication_payloads(
        VisualManifestPlan(1, 'run', 60_000, 1), [VisualChunk(0, 8, 'immutable-version')],
        VisualManifestDependencies(read, encode, 600, 60), versioned=True,
    )
    overview, manifest = json.loads(payload), json.loads(manifest_bytes)
    assert len(payload) <= 600
    assert 0 < len(overview['frames']) < len(samples)
    assert overview['sampling_interval_seconds'] == 60 / len(overview['frames'])
    assert manifest['overview'] == [[i * 5000, 0, i * 100, 100] for i in range(8)]
    assert manifest['chunk_versions'] == ['immutable-version']
    read.assert_called_once_with(0, 'immutable-version')


def test_versioned_publication_never_reads_an_unversioned_object():
    read = Mock()
    with pytest.raises(RuntimeError, match='version is missing'):
        publication_payloads(
            VisualManifestPlan(1, 'run', 60_000, 1), [VisualChunk(0, 1, None)],
            VisualManifestDependencies(read, encode, 1000, 60), versioned=True,
        )
    read.assert_not_called()
