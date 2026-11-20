"""Account deletion order and bounded leased execution, independent of storage."""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AccountDeletionDependencies:
    delete_videos: Callable[[str], None]
    delete_chat_history: Callable[[str], None]
    delete_courses: Callable[[str], None]
    delete_tags: Callable[[str], None]
    delete_remaining_vectors: Callable[[str], None]
    delete_user: Callable[[str], None]


def execute_account_deletion(user_id: str, deps: AccountDeletionDependencies) -> None:
    # Capabilities commit independently. Never remove identity before owned data.
    steps = (
        ('delete_all_videos_for_user', deps.delete_videos),
        ('delete_chat_history_for_user', deps.delete_chat_history),
        ('delete_video_courses_for_user', deps.delete_courses),
        ('delete_tags_for_user', deps.delete_tags),
        ('delete_remaining_vectors_for_user', deps.delete_remaining_vectors),
        ('delete_user_row', deps.delete_user),
    )
    for name, operation in steps:
        try:
            operation(user_id)
        except Exception:
            logger.exception('Account deletion step %s failed for user %s', name, user_id)
            raise


def execute_leased_account_deletion(
    *, renew: Callable[[], bool], step: Callable[[], str | None],
    max_steps: int = 500,
) -> None:
    for _ in range(max_steps):
        if renew() is not True:
            raise RuntimeError('Account deletion execution lease was lost')
        status = step()
        if status == 'completed':
            return
        if status != 'progress':
            raise RuntimeError('Account deletion authorization was lost')
    raise RuntimeError('Account deletion step budget exhausted; retry remaining work')
