"""Read-only diagnosis: python -m worker_python.check_embeddings [--probe]."""

import argparse
import json
import logging

from .pipeline.embedding_contract import embedding_diagnostic, resolve_embedding_config
from .pipeline.embedding_schema import check_embedding_storage
from .pipeline.embeddings import embed_texts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe", action="store_true", help="Call the configured model (may incur API charges).")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    config = resolve_embedding_config()
    check_embedding_storage()
    if args.probe:
        vector = embed_texts(["VideoQ embedding preflight"])[0]
        print(json.dumps(embedding_diagnostic(config, db_dimensions=config.dimensions, actual_dimensions=len(vector))))


if __name__ == "__main__":
    main()
