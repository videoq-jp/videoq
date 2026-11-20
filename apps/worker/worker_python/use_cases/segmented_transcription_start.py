"""Segmented start and quota recovery; adapters supply the recovery transaction."""
from dataclasses import dataclass
from typing import Callable, ContextManager

from worker_python.domain.transcription_checkpoints import TranscriptionQuotaError


@dataclass(frozen=True)
class QuotaRecovery:
    begin: Callable[[], bool]
    finish: Callable[[str], None]


def start_segmented_transcription(
    start: Callable[[], None],
    recovery: Callable[[], ContextManager[QuotaRecovery]],
) -> None:
    try:
        start()
    except TranscriptionQuotaError as error:
        with recovery() as transaction:
            # A stale source must not overwrite the winner's state.
            if transaction.begin():
                transaction.finish(str(error))
