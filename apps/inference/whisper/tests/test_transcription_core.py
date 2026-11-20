import ast
from pathlib import Path
from unittest.mock import Mock

import pytest

from transcription_core import TranscriptionDependencies, execute_transcription, transcription_result


def test_core_does_not_import_transport_numerical_or_runtime_implementations():
    path = Path(__file__).parents[1] / 'transcription_core.py'
    tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert all(alias.name in {'math', 'dataclasses', 'typing'} for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0 and node.module in {'__future__', 'dataclasses', 'typing'}
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            assert node.func.id not in {'__import__', 'eval', 'exec'}


def test_expired_work_is_not_returned_as_a_successful_transcription():
    deps = TranscriptionDependencies(duration=lambda _: 1, speech_spans=lambda _: [], recognize=Mock(return_value=[]), now=lambda: 11)
    with pytest.raises(TimeoutError, match='deadline'):
        execute_transcription(object(), deps, language=None, deadline=10)


def test_results_restore_original_gaps_and_use_requested_language():
    parts = [(0, 16000, {'language': 'en', 'segments': [{'start': 0, 'end': 2, 'text': ' First '}]}),
             (48000, 64000, {'language': 'en', 'segments': [{'start': 0, 'end': 1, 'text': ' Second '}]})]
    result = transcription_result(parts, 4, 'ja')
    assert result['language'] == 'ja'
    assert result['text'] == 'First Second'
    assert [(row['start'], row['end']) for row in result['segments']] == [(0, 1), (3, 4)]


def test_text_without_real_timestamps_is_rejected():
    with pytest.raises(ValueError, match='real timestamps'):
        transcription_result([(0, 16000, {'text': 'Invented', 'segments': []})], 1)
