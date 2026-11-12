"""Run the actual worker for a synthetic API-produced clear job, without AI I/O."""

import json
import logging
import sys

errors = []


class SafeErrors(logging.Handler):
    def emit(self, record):
        if record.exc_info:
            error = record.exc_info[1]
            seen = set()
            while error is not None and id(error) not in seen:
                seen.add(id(error))
                errors.append({"type": type(error).__name__, "sqlstate": getattr(error, "sqlstate", None)})
                error = error.__cause__


logging.root.handlers = [SafeErrors()]
logging.root.setLevel(logging.ERROR)

try:
    from worker_python.lambda_handler import handler
    from worker_python.pipeline import vector_index

    embedding_calls = 0

    def forbidden_embedding(*_args, **_kwargs):
        global embedding_calls
        embedding_calls += 1
        raise AssertionError("An explicit transcript clear must not call embeddings")

    vector_index.embed_texts = forbidden_embedding
    message = json.load(sys.stdin)
    if message.get("type") != "index_video_transcript" or message.get("payload", {}).get("allow_empty") is not True:
        raise ValueError("Only the API-produced explicit-clear fixture is permitted")
    result = handler({"Records": [{"messageId": "owned-clear-fixture", "body": json.dumps(message)}]}, None)
    print(json.dumps({**result, "embeddingCalls": embedding_calls, **({"errors": errors} if errors else {})}))
except Exception as error:
    # Never print database URLs, passwords, environment values or raw diagnostics.
    print(json.dumps({"fixtureError": type(error).__name__, "sqlstate": getattr(error, "sqlstate", None)}))
    raise SystemExit(1) from None
