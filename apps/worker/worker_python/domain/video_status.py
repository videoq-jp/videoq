"""Video processing statuses shared by tasks and database writes."""

from __future__ import annotations

from enum import Enum


class VideoStatus(str, Enum):
    UPLOADING = "uploading"
    PENDING = "pending"
    PROCESSING = "processing"
    INDEXING = "indexing"
    COMPLETED = "completed"
    ERROR = "error"
