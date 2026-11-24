"""Query preparation plans and reconstruction without files, SDKs or credentials."""
from typing import Callable


class EvaluationEmbeddingFailed(RuntimeError):
    pass


def unique_cases(manifest: dict) -> list[dict]:
    by_question = {}
    for case in manifest['cases']:
        by_question.setdefault(case['question'], case)
    return list(by_question.values())


def prepare_local_vectors(queries: list[str], batch_size: int, *, recheck: Callable[[], object],
                          embed: Callable[[list[str]], object], validate: Callable[[object], list[float]]) -> dict:
    vectors = {}
    for offset in range(0, len(queries), batch_size):
        # Configuration changes fail as configuration errors, before a paid call.
        recheck()
        batch = queries[offset:offset + batch_size]
        try:
            result = embed(batch)
            if not isinstance(result, list) or len(result) != len(batch):
                raise EvaluationEmbeddingFailed()
            for question, vector in zip(batch, result, strict=True):
                vectors[question] = validate(vector)
        except Exception:
            raise EvaluationEmbeddingFailed() from None
    return vectors


def evaluation_payload(manifest: dict, vectors: dict, *, model: str, dimensions: int,
                       manifest_sha256: str, unique_queries: int,
                       runtime: dict | None = None, invocations: int | None = None) -> dict:
    generation = {'version': 1, 'manifest_sha256': manifest_sha256,
                  'embedding': manifest['embedding'], 'case_ids': [case['id'] for case in manifest['cases']]}
    if runtime is None:
        generation.update(unique_queries=unique_queries, input_type='query', quality_evaluated=False)
    else:
        generation.update(input_type='query', unique_queries=unique_queries, runtime=runtime,
                          invocations=invocations, quality_evaluated=False)
    return {
        'version': 1, 'cohort': manifest['cohort'], 'corpusSha256': manifest['corpusSha256'],
        'model': model, 'dimensions': dimensions, 'samples': manifest['samples'],
        'cases': [{'queryEmbedding': vectors[case['question']], 'userId': case['userId'],
                   'videoIds': list(dict.fromkeys(case['videoIds'])), 'limit': case['limit']} for case in manifest['cases']],
        'generation': generation,
    }
