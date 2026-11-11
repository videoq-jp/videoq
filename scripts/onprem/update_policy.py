"""Conservative scheduling rules for the native single-GPU updater."""
from datetime import datetime
from zoneinfo import ZoneInfo

# These counters must come from DB, SQS and Kubernetes observations. GPU load
# alone cannot distinguish idle from queued/uploading/running application work.
WORK_COUNTERS = frozenset(('videos', 'jobs', 'visual_runs', 'answers', 'uploads',
                          'queue_visible', 'queue_inflight', 'queue_delayed',
                          'maintenance_jobs'))


def in_window(now: datetime, *, timezone='Asia/Tokyo', start=3, end=5):
    if now.tzinfo is None:
        raise ValueError('The update clock must include a timezone')
    if any(type(hour) is not int or not 0 <= hour <= 23 for hour in (start, end)) or start == end:
        raise ValueError('Specify distinct start/end hours from 0 to 23')
    hour = now.astimezone(ZoneInfo(timezone)).hour
    return start <= hour < end if start < end else hour >= start or hour < end


def busy(observation):
    if not isinstance(observation, dict) or set(observation) != WORK_COUNTERS:
        raise ValueError('Missing workload observations; the update must be deferred')
    if any(type(value) is not int or value < 0 for value in observation.values()):
        raise ValueError('Invalid workload observations; the update must be deferred')
    return any(observation.values())


def release_order(current, candidate):
    """Called only after full provenance verification of the candidate.

    Enforce a monotonic successful workflow run/attempt, rather than a mutable
    branch/tag name or an arbitrary semantic version supplied by the server.
    """
    def identity(release):
        run, attempt = str(release['run_id']), release['run_attempt']
        if not run.isascii() or not run.isdecimal() or int(run) <= 0 or type(attempt) is not int or attempt <= 0:
            raise ValueError('Invalid verified release identity')
        source = release['source_sha']
        if not isinstance(source, str) or len(source) != 40 or any(c not in '0123456789abcdef' for c in source):
            raise ValueError('Invalid verified release source')
        return int(run), attempt
    old, new = identity(current), identity(candidate)
    if new < old:
        raise ValueError('Automatic release downgrade is forbidden')
    if new == old and candidate['source_sha'] != current['source_sha']:
        raise ValueError('The same release run cannot change its source')
    return new > old
