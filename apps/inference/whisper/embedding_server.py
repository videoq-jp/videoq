"""Offline, text-only EmbeddingGemma 2 service for VideoQ's private network.

Runs in a separate Pod using the shared CPU inference image. Models are
provisioned before startup; neither requests nor startup download remote code.
"""
from contextlib import asynccontextmanager
import os
from pathlib import Path
import threading
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, ConfigDict, Field

DIMENSIONS = 768
MODEL_ALIAS = os.environ.get("EMBEDDING_MODEL_ALIAS", "embeddinggemma-2-f9972ac")
_lock = threading.Lock()


def load_model():
    import torch
    from sentence_transformers import SentenceTransformer

    directory = Path(os.environ["EMBEDDING_MODEL_PATH"])
    if not directory.is_dir():
        raise RuntimeError("Provision the pinned EmbeddingGemma 2 snapshot before startup")
    torch.set_num_threads(int(os.environ.get("EMBEDDING_CPU_THREADS", "2")))
    model = SentenceTransformer(
        str(directory), device="cpu", local_files_only=True, trust_remote_code=False,
        config_kwargs={"vision_config": None, "audio_config": None},
        model_kwargs={"torch_dtype": torch.float32},
    )
    if model.get_sentence_embedding_dimension() != DIMENSIONS:
        raise RuntimeError("EmbeddingGemma 2 must return 768 dimensions")
    if not {"SearchQuery", "Document"}.issubset(model.prompts):
        raise RuntimeError("The pinned model must define SearchQuery and Document prompts")
    return model


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.model = load_model()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


class EmbeddingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    model: str
    input: str | list[str] = Field(min_length=1, max_length=64 * 8192)
    input_type: Literal["query", "document"]
    dimensions: Literal[768] = 768
    encoding_format: Literal["float"] = "float"


@app.get("/health")
def health():
    return {"status": "ok", "model": MODEL_ALIAS, "dimensions": DIMENSIONS}


@app.post("/v1/embeddings")
def embeddings(request: EmbeddingRequest):
    if request.model != MODEL_ALIAS:
        raise HTTPException(404, "Unknown embedding model")
    texts = [request.input] if isinstance(request.input, str) else request.input
    if not 1 <= len(texts) <= 64 or any(not text.strip() for text in texts):
        raise HTTPException(422, "Expected 1 to 64 nonempty texts")
    if sum(len(text) for text in texts) > 64 * 8192:
        raise HTTPException(413, "Embedding batch is too large")
    model = app.state.model
    prompt = "SearchQuery" if request.input_type == "query" else "Document"
    # Reject overlong texts instead of silently truncating evidence.
    with _lock:
        tokens = model.tokenizer([model.prompts[prompt] + text for text in texts], truncation=False)["input_ids"]
        if any(len(row) > model.max_seq_length for row in tokens):
            raise HTTPException(422, "Text exceeds the model context window")
        vectors = model.encode(texts, prompt_name=prompt, normalize_embeddings=True,
                               batch_size=8, show_progress_bar=False, convert_to_numpy=True)
    return {
        "object": "list", "model": MODEL_ALIAS,
        "data": [{"object": "embedding", "index": index, "embedding": vector.tolist()}
                 for index, vector in enumerate(vectors)],
        "usage": {"prompt_tokens": sum(map(len, tokens)), "total_tokens": sum(map(len, tokens))},
    }
