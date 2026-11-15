from unittest.mock import MagicMock, call
from contextlib import nullcontext

import numpy as np
import pytest
import tiktoken

from worker_python.pipeline.scene_otsu import (
    SceneSplitter,
    SceneEmbedder,
    apply_scene_splitting,
    l2_normalize,
)
from worker_python.pipeline.scene_otsu.splitter import SceneSplitter as SplitterCls
from worker_python.pipeline.srt import format_srt_time, parse_srt_scenes
from worker_python.pipeline import transcription, vector_index
from worker_python.pipeline.embedding_contract import EMBEDDING_DIMENSIONS
from worker_python.pipeline.scene_otsu import embedders
from worker_python.video_sql import VideoRow


@pytest.mark.parametrize("cue_count", [0, 1, 16, 17, 48, 49])
def test_embedding_batches_preserve_cue_order_and_float64(monkeypatch, cue_count) -> None:
    monkeypatch.setattr(embedders, "_resolve_encoding", lambda: None)
    texts = [str(i) for i in range(cue_count)]
    expected = np.arange(cue_count * EMBEDDING_DIMENSIONS, dtype=np.float32).reshape(
        cue_count, EMBEDDING_DIMENSIONS
    ) / 7
    embed = MagicMock(side_effect=lambda batch: [expected[int(text)].tolist() for text in batch])
    monkeypatch.setattr(embedders, "embed_texts", embed)

    result = SceneEmbedder(batch_size=16).get_embeddings(texts)

    assert result.dtype == np.float64
    np.testing.assert_array_equal(result, expected if cue_count else np.zeros((0, 0)))
    assert embed.call_args_list == [call(texts[i : i + 16]) for i in range(0, cue_count, 16)]


@pytest.mark.parametrize("batch_size", [0, -1])
def test_embedding_batches_reject_invalid_size_before_request(monkeypatch, batch_size) -> None:
    monkeypatch.setattr(embedders, "_resolve_encoding", lambda: None)
    embed = MagicMock()
    monkeypatch.setattr(embedders, "embed_texts", embed)
    with pytest.raises(ValueError, match="batch_size"):
        SceneEmbedder(batch_size=batch_size).get_embeddings(["cue"])
    embed.assert_not_called()


def test_embedding_batches_propagate_later_failure(monkeypatch) -> None:
    monkeypatch.setattr(embedders, "_resolve_encoding", lambda: None)
    error = RuntimeError("embedding request failed")
    embed = MagicMock(side_effect=[[[1.0] * EMBEDDING_DIMENSIONS], error])
    monkeypatch.setattr(embedders, "embed_texts", embed)
    with pytest.raises(RuntimeError) as caught:
        SceneEmbedder(batch_size=1).get_embeddings(["first", "second", "third"])
    assert caught.value is error
    assert embed.call_args_list == [call(["first"]), call(["second"])]


@pytest.fixture
def literal_embedder(monkeypatch):
    # Real tiktoken with byte tokens makes UTF-8 boundaries deterministic and offline.
    encoding = tiktoken.Encoding(
        name="utf8-test",
        pat_str=r"[\s\S]+",
        mergeable_ranks={bytes([value]): value for value in range(256)},
        special_tokens={"<|endoftext|>": 256},
    )
    monkeypatch.setattr(
        "worker_python.pipeline.scene_otsu.embedders._resolve_encoding", lambda: encoding
    )
    embedder = SceneEmbedder()
    embedder.encoding = MagicMock(wraps=encoding)
    embedder.get_embeddings = MagicMock(side_effect=AssertionError("Unexpected embedding call"))
    return embedder


@pytest.mark.parametrize("source_type", ["youtube", "uploaded"])
def test_transcription_preserves_original_cues_for_playback_and_window_reads(
    monkeypatch, source_type
) -> None:
    source = (
        "1\n00:00:00,000 --> 00:00:01,000\n2026\n\n"
        "2\n00:04:20,125 --> 00:04:21,250\nThe answer is\n42\n"
    )
    monkeypatch.setattr(transcription, "heavy_pipeline_enabled", lambda: True)
    monkeypatch.setattr(transcription, "_transcribe_youtube", lambda *_: (source, 262))
    monkeypatch.setattr(transcription, "_transcribe_uploaded", lambda *_, **__: source)
    monkeypatch.setattr(
        "worker_python.pipeline.scene_otsu.splitter.SceneEmbedder",
        lambda **_: pytest.fail("Transcription must not group or embed original cues"),
    )
    video = VideoRow(
        id=1, user_id="owner", title="Title", transcript=None, status="processing",
        source_type=source_type, file_key="videos/owner/1.mp4", youtube_video_id="video",
    )
    reserve = MagicMock()
    assert transcription.run_transcription(video, reserve_processing=reserve) == source
    if source_type == "youtube":
        reserve.assert_called_once_with(262)


def test_scene_count_excludes_whitespace_only_chunks(monkeypatch, literal_embedder, caplog) -> None:
    monkeypatch.setattr(
        "worker_python.pipeline.scene_otsu.splitter.SceneEmbedder",
        lambda **_: literal_embedder,
    )
    caplog.set_level("INFO", logger="worker_python.pipeline.scene_otsu")
    result = apply_scene_splitting(
        "1\n00:00:00,000 --> 00:00:06,000\na    b\n", max_tokens=2
    )
    assert [scene.text for scene in parse_srt_scenes(result)] == ["a", "b"]
    assert "Original: 1 segments, Scenes: 2" in caplog.text


@pytest.mark.parametrize(
    ("text", "budget"),
    [
        ("日本語の字幕を分割します。" * 6, 5),
        ("😊🎥" * 12, 7),
        ("説明<|endoftext|>字幕", 512),
        ("説明<|endoftext|>字幕" * 6, 17),
    ],
)
def test_process_preserves_unicode_and_literal_token_markers(
    literal_embedder, text, budget
) -> None:
    source = f"1\n00:00:00,000 --> 00:00:10,000\n{text}\n"
    output = SceneSplitter(embedder=literal_embedder).process(source, max_tokens=budget)
    scenes = parse_srt_scenes(output)

    assert "".join(scene.text for scene in scenes) == text
    assert scenes[0].start_sec == 0
    assert scenes[-1].end_sec == 10
    assert all(left.end_sec == right.start_sec for left, right in zip(scenes, scenes[1:]))
    assert all(scene.start_sec < scene.end_sec for scene in scenes)
    literal_embedder.get_embeddings.assert_not_called()
    assert literal_embedder.encoding.encode_ordinary.call_args_list.count(call(text)) == 1
    for scene in scenes:
        assert len(literal_embedder.encoding.encode_ordinary(scene.text)) <= budget


@pytest.mark.parametrize("budget", [0, -1, 3])
def test_process_rejects_a_budget_that_cannot_preserve_a_character(
    literal_embedder, budget
) -> None:
    source = "1\n00:00:00,000 --> 00:00:10,000\n😊\n"
    with pytest.raises(ValueError, match="max_tokens"):
        SceneSplitter(embedder=literal_embedder).process(source, max_tokens=budget)
    literal_embedder.get_embeddings.assert_not_called()


def test_semantic_split_reuses_long_cue_scenes_in_the_correct_position(literal_embedder) -> None:
    texts = ["短", "😊" * 5, "字幕"]
    literal_embedder.get_embeddings = MagicMock(return_value=np.eye(3))
    source = "\n\n".join(
        f"{index + 1}\n{format_srt_time(index)} --> {format_srt_time(index + 1)}\n{text}"
        for index, text in enumerate(texts)
    )
    output = SceneSplitter(embedder=literal_embedder).process(source, max_tokens=7)
    scenes = parse_srt_scenes(output)

    assert [scene.text for scene in scenes] == ["短", *["😊"] * 5, "字幕"]
    assert [(scene.start_sec, scene.end_sec) for scene in scenes] == [
        (0, 1), (1, 1.2), (1.2, 1.4), (1.4, 1.6), (1.6, 1.8), (1.8, 2), (2, 3),
    ]
    assert all(literal_embedder.encoding.encode_ordinary.call_args_list.count(call(text)) == 1 for text in texts)
    literal_embedder.get_embeddings.assert_called_once_with(texts)


def test_long_transcript_with_unbalanced_splits_preserves_cues_and_order() -> None:
    cue_count = 1100
    texts = [f"cue {index}" for index in range(cue_count)]
    embedder = MagicMock()
    embedder.encoding.encode_ordinary.return_value = list(range(300))
    # Identical vectors make every threshold tie, so the first boundary wins.
    embedder.get_embeddings.return_value = np.tile([1.0, 0.0], (cue_count, 1))
    srt = "\n\n".join(
        f"{index + 1}\n{format_srt_time(index)} --> {format_srt_time(index + 1)}\n{text}"
        for index, text in enumerate(texts)
    )

    result = SceneSplitter(embedder=embedder).process(srt, max_tokens=512)

    scenes = parse_srt_scenes(result)
    assert [scene.text for scene in scenes] == texts
    assert [(scene.start_sec, scene.end_sec) for scene in scenes] == [
        (index, index + 1) for index in range(cue_count)
    ]
    embedder.get_embeddings.assert_called_once_with(texts)


def test_l2_normalize_unit_rows() -> None:
    mat = np.array([[3.0, 4.0], [0.0, 5.0]], dtype=np.float64)
    out = l2_normalize(mat)
    norms = np.linalg.norm(out, axis=1)
    assert np.allclose(norms, [1.0, 1.0])


def test_find_otsu_threshold_single() -> None:
    splitter = SplitterCls(embedder=MagicMock())
    assert splitter._find_otsu_threshold(np.array([[0.1, 0.2, 0.3]])) == 0


def test_find_otsu_threshold_two_clusters() -> None:
    splitter = SplitterCls(embedder=MagicMock())
    embeddings = np.array(
        [
            [1.0, 0.0],
            [0.9, 0.1],
            [0.8, 0.2],
            [0.0, 1.0],
            [0.1, 0.9],
        ]
    )
    result = splitter._find_otsu_threshold(embeddings)
    assert result in {3, 4}


@pytest.mark.parametrize("newline", ["\n", "\r\n", "\r"])
def test_process_merges_under_token_budget(newline: str) -> None:
    mock_embedder = MagicMock()
    mock_embedder.encoding.encode_ordinary.side_effect = lambda t: list(
        range(len(t.split()) or 1)
    )
    # Two similar cues → one scene when total tokens <= max_tokens
    mock_embedder.get_embeddings.return_value = np.array(
        [[1.0, 0.0], [0.99, 0.01]], dtype=np.float64
    )

    splitter = SceneSplitter(embedder=mock_embedder)
    srt = (
        "1\n00:00:00,000 --> 00:00:01,000\nhello world\n\n"
        "2\n00:00:01,000 --> 00:00:02,000\nhello there\n"
    ).replace("\n", newline)
    out = splitter.process(srt, max_tokens=512)
    # Both cues fit in one scene
    assert out.count("-->") == 1
    assert "hello world" in out and "hello there" in out
    assert "00:00:00,000 --> 00:00:02,000" in out
    mock_embedder.get_embeddings.assert_not_called()


@pytest.mark.parametrize("word_count", [1, 600])
def test_process_single_cue_needs_no_embeddings(word_count: int) -> None:
    words = [f"word{i}" for i in range(word_count)]
    embedder = MagicMock()
    embedder.encoding.encode_ordinary.side_effect = lambda text: text.split()
    embedder.encoding.decode.side_effect = lambda tokens, errors: " ".join(tokens)
    embedder.get_embeddings.return_value = np.array([[1.0, 0.0]])
    srt = f"1\n00:00:00,000 --> 00:00:10,000\n{' '.join(words)}\n"

    out = SceneSplitter(embedder=embedder).process(srt, max_tokens=512)

    assert out.count("-->") == (word_count + 511) // 512
    assert "00:00:00,000 -->" in out
    assert "--> 00:00:10,000" in out
    texts = [block.split("\n", 2)[2] for block in out.strip().split("\n\n")]
    assert " ".join(texts).split() == words
    embedder.get_embeddings.assert_not_called()
    assert embedder.encoding.encode_ordinary.call_args_list.count(call(" ".join(words))) == 1


@pytest.mark.parametrize("cue_count", [2, 4])
def test_process_splits_dissimilar_when_over_budget(cue_count: int) -> None:
    mock_embedder = MagicMock()
    # Each cue is 300 tokens → together 600 > 512, must split
    mock_embedder.encoding.encode_ordinary.side_effect = lambda t: list(range(300))
    mock_embedder.get_embeddings.return_value = np.eye(cue_count)

    splitter = SceneSplitter(embedder=mock_embedder)
    texts = ["alpha", "beta", "gamma", "delta"][:cue_count]
    srt = "\n\n".join(
        f"{i + 1}\n00:00:0{i},000 --> 00:00:0{i + 1},000\n{text}"
        for i, text in enumerate(texts)
    )
    out = splitter.process(srt, max_tokens=512)
    assert out.count("-->") == cue_count
    if cue_count == 2:
        mock_embedder.get_embeddings.assert_not_called()
    else:
        mock_embedder.get_embeddings.assert_called_once_with(texts)


@pytest.mark.parametrize("texts", [("abc", "def"), ("日本語", "😊🎥"), ("a" * 19, "b" * 15)])
def test_two_cues_split_without_embeddings_and_preserve_chunks(literal_embedder, texts) -> None:
    source = "\n\n".join(
        f"{index + 1}\n{format_srt_time(index * 10)} --> {format_srt_time((index + 1) * 10)}\n{text}"
        for index, text in enumerate(texts)
    )

    output = SceneSplitter(embedder=literal_embedder).process(source, max_tokens=5)

    scenes = parse_srt_scenes(output)
    assert "".join(scene.text for scene in scenes if scene.start_sec < 10) == texts[0]
    assert "".join(scene.text for scene in scenes if scene.start_sec >= 10) == texts[1]
    assert scenes[0].start_sec == 0
    assert scenes[-1].end_sec == 20
    assert all(left.end_sec == right.start_sec for left, right in zip(scenes, scenes[1:]))
    assert all(len(literal_embedder.encoding.encode_ordinary(scene.text)) <= 5 for scene in scenes)
    literal_embedder.get_embeddings.assert_not_called()


@pytest.mark.parametrize(
    ("texts", "budget", "scene_count"),
    [
        (["abc", "def"], 6, 2),
        (["abc", "def"], 7, 1),
        ([letter * 128 for letter in "abcd"], 512, 2),
    ],
)
def test_merged_scenes_count_joining_spaces_in_the_token_budget(
    literal_embedder, texts, budget, scene_count
) -> None:
    literal_embedder.get_embeddings = MagicMock(return_value=np.eye(len(texts)))
    source = "\n\n".join(
        f"{index + 1}\n{format_srt_time(index)} --> {format_srt_time(index + 1)}\n{text}"
        for index, text in enumerate(texts)
    )

    output = SceneSplitter(embedder=literal_embedder).process(source, max_tokens=budget)
    scenes = parse_srt_scenes(output)

    assert len(scenes) == scene_count
    assert " ".join(scene.text for scene in scenes) == " ".join(texts)
    assert all(len(literal_embedder.encoding.encode_ordinary(scene.text)) <= budget for scene in scenes)
    assert scenes[0].start_sec == 0
    assert scenes[-1].end_sec == len(texts)
    assert all(left.end_sec == right.start_sec for left, right in zip(scenes, scenes[1:]))
    if len(texts) == 2:
        literal_embedder.get_embeddings.assert_not_called()
    else:
        literal_embedder.get_embeddings.assert_called_once_with(texts)


@pytest.mark.parametrize(("budget", "words"), [(3, 12), (512, 1200)])
def test_long_cue_budget_counts_the_text_after_srt_whitespace_normalization(budget, words) -> None:
    # A leading-space token is shorter than its stripped text, as with real BPE
    # vocabularies. This small real tokenizer keeps the regression offline.
    encoding = tiktoken.Encoding(
        name="leading-space-test",
        pat_str=r" ?[a-z]+|\s+|[^a-z\s]+",
        mergeable_ranks={**{bytes([value]): value for value in range(256)}, b" a": 256, b" aa": 257},
        special_tokens={},
    )
    embedder = MagicMock()
    embedder.encoding = encoding
    text = " ".join(["aa"] * words)
    source = f"1\n00:00:00,000 --> 00:20:00,000\n{text}\n"

    scenes = parse_srt_scenes(SceneSplitter(embedder=embedder).process(source, max_tokens=budget))

    assert " ".join(scene.text for scene in scenes) == text
    assert all(len(encoding.encode_ordinary(scene.text)) <= budget for scene in scenes)
    assert scenes[0].start_sec == 0
    assert scenes[-1].end_sec == 1200
    assert all(left.end_sec == right.start_sec for left, right in zip(scenes, scenes[1:]))
    embedder.get_embeddings.assert_not_called()


def test_apply_scene_splitting_degrades_on_failure(monkeypatch, caplog) -> None:
    def boom(*_a, **_k):
        raise RuntimeError("synthetic-private-embedding-provider-token")

    monkeypatch.setattr(
        "worker_python.pipeline.scene_otsu.SceneSplitter",
        lambda *a, **k: MagicMock(process=boom),
    )
    original = "1\n00:00:00,000 --> 00:00:01,000\nkeep me\n"
    assert apply_scene_splitting(original) == original
    assert "synthetic-private-embedding-provider-token" not in caplog.text
    assert "Scene splitting failed" in caplog.text


@pytest.mark.parametrize("source", ["", " \r\n ", "not a subtitle"])
def test_apply_scene_splitting_with_no_valid_cues(monkeypatch, literal_embedder, source) -> None:
    monkeypatch.setattr(
        "worker_python.pipeline.scene_otsu.splitter.SceneEmbedder",
        lambda **_: literal_embedder,
    )
    assert apply_scene_splitting(source) == ""
    literal_embedder.encoding.encode_ordinary.assert_not_called()
    literal_embedder.get_embeddings.assert_not_called()


def test_indexing_groups_search_scenes_but_retains_original_timestamps_and_race_check(
    monkeypatch, literal_embedder,
) -> None:
    source = (
        "1\n00:00:00,000 --> 00:00:01,000\nFirst\n\n"
        "2\n00:04:20,125 --> 00:04:21,250\nSecond\n"
    )
    video = VideoRow(
        id=1, user_id="owner", title="Title", transcript=source, status="indexing",
        source_type="uploaded", file_key=None, youtube_video_id=None,
    )
    monkeypatch.setattr("worker_python.pipeline.scene_otsu.splitter.SceneEmbedder", lambda **_: literal_embedder)
    monkeypatch.setattr(vector_index, "check_embedding_storage", lambda: None)
    embed = MagicMock(return_value=[[1.0]])
    monkeypatch.setattr(vector_index, "embed_texts", embed)
    conn = MagicMock()
    conn.execute.return_value.fetchone.return_value = {"title": "Title", "transcript_matches": True}
    monkeypatch.setattr(vector_index, "db_connection", lambda: nullcontext(conn))
    inserted = []
    conn.cursor.return_value.__enter__.return_value.executemany.side_effect = lambda _sql, rows: inserted.extend(rows)

    assert vector_index.index_video_transcript(video) == 1
    embed.assert_called_once_with(["First Second"])
    assert inserted[0][1] == "First Second"
    assert inserted[0][5].obj["end_time"] == "00:04:21,250"
    assert conn.execute.call_args_list[0].args[1] == (source, 1, "owner")
    assert video.transcript == source
    assert [(cue.start_time, cue.end_time) for cue in parse_srt_scenes(video.transcript)] == [
        ("00:00:00,000", "00:00:01,000"), ("00:04:20,125", "00:04:21,250"),
    ]
    literal_embedder.get_embeddings.assert_not_called()
