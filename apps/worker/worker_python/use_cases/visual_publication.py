"""Immutable publication lifecycle, independent of storage and persistence transports."""
from dataclasses import dataclass
from typing import Callable, Generic, TypeVar

Pack = TypeVar('Pack')


@dataclass(frozen=True)
class PublicationResult:
    accepted: bool
    object_version: str | None


@dataclass(frozen=True)
class VisualChunk:
    index: int
    frame_count: int | None
    object_version: str | None


@dataclass(frozen=True)
class VisualPublicationDependencies(Generic[Pack]):
    new_version: Callable[[], str]
    register: Callable[[str, int | None], bool]
    chunk_keys: Callable[[int, str], tuple[str, str]]
    manifest_keys: Callable[[str], tuple[str, str]]
    upload_pack: Callable[[str, Pack], None]
    upload_json: Callable[[str, bytes], None]
    delete: Callable[[str], None]
    publish_chunk: Callable[[int, int, str], PublicationResult]
    chunks: Callable[[], list[VisualChunk] | None]
    prepare_manifest: Callable[[list[VisualChunk]], tuple[bytes, bytes]]
    publish_manifest: Callable[[str], PublicationResult]
    load_status: Callable[[], str | None]


def publish_chunk(index: int, pack: Pack, sparse: bytes, count: int,
                  deps: VisualPublicationDependencies[Pack]) -> bool:
    version = deps.new_version()
    if not deps.register(version, index):
        return False
    binary_key, json_key = deps.chunk_keys(index, version)
    try:
        deps.upload_pack(binary_key, pack)
        deps.upload_json(json_key, sparse)
    except Exception:
        for key in (binary_key, json_key):
            try:
                deps.delete(key)
            except Exception:
                pass  # A storage outage can also defer orphan cleanup.
        raise
    result = deps.publish_chunk(index, count, version)
    if not result.accepted or result.object_version != version:
        # Only this attempt's objects may be removed, never the winning version.
        deps.delete(binary_key)
        deps.delete(json_key)
    return result.accepted


def finish_run(deps: VisualPublicationDependencies[Pack]) -> None:
    chunks = deps.chunks()
    if chunks is None:
        return
    payload, manifest = deps.prepare_manifest(chunks)
    version = deps.new_version()
    overview_key, manifest_key = deps.manifest_keys(version)
    if not deps.register(version, None):
        current = deps.load_status()
        if current is not None and current != 'ready':
            raise RuntimeError('Visual publication is waiting for object recovery; retry')
        return
    deps.upload_json(overview_key, payload)
    deps.upload_json(manifest_key, manifest)
    result = deps.publish_manifest(version)
    if not result.accepted or result.object_version != version:
        deps.delete(overview_key)
        deps.delete(manifest_key)
        if result.accepted:
            return  # Another immutable publication won.
        if deps.load_status() is not None:
            raise RuntimeError('Visual publication did not complete; retry')
