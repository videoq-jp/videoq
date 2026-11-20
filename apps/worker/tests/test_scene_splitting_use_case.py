from unittest.mock import Mock
from worker_python.domain.srt import parse_srt_scenes
from worker_python.use_cases.scene_splitting import SceneSplittingPolicy


class LiteralEncoding:
    def encode_ordinary(self, text):
        return list(map(ord, text))

    def decode(self, tokens, *, errors):
        return "".join(map(chr, tokens))


def test_budget_fitting_cues_do_not_pay_for_embeddings_or_boundary_computation():
    vectors, boundary = Mock(), Mock()
    policy = SceneSplittingPolicy(LiteralEncoding(), vectors, boundary)
    result = policy.process("1\n00:00:00,000 --> 00:00:01,000\nA\n\n2\n00:00:01,000 --> 00:00:02,000\nB", 3)
    assert [scene.text for scene in parse_srt_scenes(result)] == ["A B"]
    vectors.assert_not_called()
    boundary.assert_not_called()


def test_over_budget_splitting_reuses_opaque_vectors_and_preserves_cue_order():
    matrix = object()
    vectors = Mock(return_value=matrix)
    boundary = Mock(return_value=2)
    policy = SceneSplittingPolicy(LiteralEncoding(), vectors, boundary)
    source = "\n\n".join(f"{i+1}\n00:00:0{i},000 --> 00:00:0{i+1},000\n{text}" for i, text in enumerate(["AA", "BB", "CC", "DD"]))
    result = parse_srt_scenes(policy.process(source, 3))
    assert [scene.text for scene in result] == ["AA", "BB", "CC", "DD"]
    assert result[0].start_time == "00:00:00,000"
    assert result[-1].end_time == "00:00:04,000"
    vectors.assert_called_once_with(["AA", "BB", "CC", "DD"])
    boundary.assert_called_once_with(matrix, 0, 3)
