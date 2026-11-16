"""Plan candidate Vectorize synchronization from frozen D1 scene authority.

Pure data planning; no provider writes, model calls or outbox changes. Unknown
source vectors are omitted, obsolete candidate IDs deleted, and pending vectors
without a source copy remain explicitly deferred only with retained D1 payload.
"""
import math
from d1_resource_write_fence import fingerprint

DIMENSIONS = (768, 1536)


def vector_key(row):
    return row['dimensions'], row['vector_id']


def plan_vectors(authority, sources, candidates):
    if not isinstance(authority, list) or set(sources) != set(DIMENSIONS) or set(candidates) != set(DIMENSIONS):
        raise ValueError('RESOURCE_VECTOR_AUTHORITY_REQUIRED')
    desired = {}
    for row in authority:
        if (not isinstance(row, dict) or set(row) != {'vector_id', 'scene_id', 'revision', 'video_id', 'user_id', 'dimensions', 'legacy', 'pending_payload'}
                or row['dimensions'] not in DIMENSIONS or type(row['dimensions']) is not int
                or type(row['video_id']) is not int or not 0 < row['video_id'] <= 9007199254740991
                or type(row['legacy']) is not bool or type(row['pending_payload']) is not bool
                or any(not isinstance(row[name], str) or not row[name] for name in ('vector_id', 'scene_id', 'revision', 'user_id'))
                or len(row['vector_id'].encode()) > 64):
            raise ValueError('RESOURCE_VECTOR_AUTHORITY_INVALID')
        key = vector_key(row)
        if key in desired and desired[key] != row:
            raise ValueError('RESOURCE_VECTOR_AUTHORITY_COLLISION')
        desired[key] = row
    def inventory(rows, dimensions, source):
        if not isinstance(rows, list):
            raise ValueError('RESOURCE_VECTOR_INVENTORY_REQUIRED')
        by_id = {}
        for vector in rows:
            if not isinstance(vector, dict) or not isinstance(vector.get('id'), str) or not vector['id'] or len(vector['id'].encode()) > 64 or vector['id'] in by_id:
                raise ValueError('RESOURCE_VECTOR_ID_INVALID')
            if source and (dimensions, vector['id']) in desired:
                if set(vector) - {'id', 'values', 'metadata', 'namespace'}:
                    raise ValueError('RESOURCE_VECTOR_FIELDS_INVALID')
                values = vector.get('values')
                if (not isinstance(values, list) or len(values) != dimensions
                        or any(type(v) not in (int, float) or not math.isfinite(v) or abs(v) > 3.4028234663852886e38 for v in values)
                        or not any(abs(v) > 7.006492321624085e-46 for v in values)):
                    raise ValueError('RESOURCE_VECTOR_VALUES_INVALID')
                if vector.get('namespace') not in (None, ''):
                    raise ValueError('RESOURCE_VECTOR_NAMESPACE_REVIEW_REQUIRED')
                metadata, expected = vector.get('metadata'), desired[dimensions, vector['id']]
                if not isinstance(metadata, dict) or type(metadata.get('video_id')) not in (int, float) or any(metadata.get(key) != expected[key] for key in ('scene_id', 'revision', 'video_id', 'user_id')):
                    raise ValueError('RESOURCE_VECTOR_SCOPE_MISMATCH')
                if metadata.get('vector_id') != expected['vector_id'] and not (expected['legacy'] and metadata.get('vector_id') is None and vector['id'] == expected['scene_id']):
                    raise ValueError('RESOURCE_VECTOR_VERSION_MISMATCH')
                vector = {key: value for key, value in vector.items() if key != 'namespace'}
            by_id[vector['id']] = vector
        return by_id
    indexes = []
    for dimensions in DIMENSIONS:
        source = inventory(sources[dimensions], dimensions, True)
        candidate = inventory(candidates[dimensions], dimensions, False)
        expected = {identifier: row for (d, identifier), row in desired.items() if d == dimensions}
        payload, deferred = [], []
        for identifier, row in sorted(expected.items()):
            if identifier not in source:
                if not row['pending_payload']:
                    raise ValueError('RESOURCE_VECTOR_REQUIRED_SOURCE_MISSING')
                deferred.append(identifier)
            else:
                payload.append(source[identifier])
        kept = {row['id'] for row in payload}
        indexes.append({'dimensions': dimensions, 'upsert': payload, 'delete': sorted(set(candidate) - kept),
                        'deferred': deferred, 'vectorsSha256': fingerprint(payload)})
    return {'version': 1, 'authoritySha256': fingerprint(sorted(desired.values(), key=vector_key)),
            'indexes': indexes, 'modelCallsRequired': False, 'outboxMutationsRequired': False}

# Mirror the application task repository's current scenes OR current staging
# authority. Pending means the copied D1 still retains a usable embedding payload;
# accepted tasks with cleared payload cannot justify a missing source vector.
AUTHORITY_SQL = """WITH desired AS (
 SELECT coalesce(s.vector_id,s.id) AS vector_id,s.id AS scene_id,s.revision,
        s.video_id,v.user_id,s.dimensions,(s.vector_id IS NULL) AS legacy
 FROM scenes s JOIN videos v ON v.id=s.video_id
 UNION
 SELECT s.vector_id,s.scene_id,r.id,r.video_id,r.user_id,r.dimensions,0
 FROM scene_staging s JOIN scene_index_runs r ON r.id=s.run_id
 JOIN videos v ON v.id=r.video_id JOIN video_index_versions versions ON versions.video_id=v.id
 JOIN video_index_heads heads ON heads.video_id=v.id AND heads.dimensions=r.dimensions
 WHERE v.user_id=r.user_id AND r.source_revision=versions.revision AND heads.run_id=r.id AND r.status='staging'
)
SELECT d.vector_id,d.scene_id,d.revision,CAST(d.video_id AS TEXT) AS video_id,d.user_id,d.dimensions,d.legacy,
 EXISTS(SELECT 1 FROM scene_index_tasks t WHERE t.operation='upsert' AND t.completed_at IS NULL
  AND t.accepted_at IS NULL AND t.vector_id=d.vector_id AND t.scene_id=d.scene_id AND t.revision=d.revision
  AND t.video_id=d.video_id AND t.user_id=d.user_id AND t.dimensions=d.dimensions
  AND CASE WHEN json_valid(t.embedding) THEN CASE WHEN json_type(t.embedding)='array' THEN
   json_array_length(t.embedding)=d.dimensions
   AND NOT EXISTS(SELECT 1 FROM json_each(t.embedding) j WHERE j.type NOT IN('integer','real')
    OR j.value < -3.4028234663852886e38 OR j.value > 3.4028234663852886e38)
   AND EXISTS(SELECT 1 FROM json_each(t.embedding) j WHERE j.value < -7.006492321624085e-46 OR j.value > 7.006492321624085e-46)
  ELSE 0 END ELSE 0 END) AS pending_payload
 FROM desired d"""


def read_authority(query, assert_fenced):
    if not callable(query) or not callable(assert_fenced):
        raise ValueError('RESOURCE_VECTOR_AUTHORITY_CONTEXT_REQUIRED')
    rows, offset = [], 0
    assert_fenced()
    counts = query('SELECT CAST(count(*) AS TEXT) AS rows FROM (' + AUTHORITY_SQL + ')')
    if not isinstance(counts, list) or len(counts) != 1 or not isinstance(counts[0].get('rows'), str) or not counts[0]['rows'].isdigit():
        raise ValueError('RESOURCE_VECTOR_AUTHORITY_COUNT_INVALID')
    total = int(counts[0]['rows'])
    while True:
        assert_fenced()
        page = query(AUTHORITY_SQL + f' ORDER BY dimensions,vector_id,scene_id,revision LIMIT 100 OFFSET {offset}')
        if not isinstance(page, list) or len(page) > 100:
            raise ValueError('RESOURCE_VECTOR_AUTHORITY_PAGE_INVALID')
        for row in page:
            if (set(row) != {'vector_id','scene_id','revision','video_id','user_id','dimensions','legacy','pending_payload'}
                    or not isinstance(row['video_id'], str) or not row['video_id'].isascii() or not row['video_id'].isdigit()
                    or type(row['legacy']) is not int or row['legacy'] not in (0,1)
                    or type(row['pending_payload']) is not int or row['pending_payload'] not in (0,1)):
                raise ValueError('RESOURCE_VECTOR_AUTHORITY_ROW_INVALID')
            rows.append({**row, 'video_id': int(row['video_id']), 'legacy': bool(row['legacy']), 'pending_payload': bool(row['pending_payload'])})
        offset += len(page)
        assert_fenced()
        if len(page) < 100:
            break
    if len(rows) != total:
        raise ValueError('RESOURCE_VECTOR_AUTHORITY_COUNT_MISMATCH')
    return rows


def candidate_status(plan, candidates):
    """Mutation acknowledgement is never proof: compare every stored value."""
    if (not isinstance(plan, dict) or plan.get('version') != 1 or not isinstance(plan.get('indexes'), list)
            or [row.get('dimensions') for row in plan['indexes']] != list(DIMENSIONS)
            or set(candidates) != set(DIMENSIONS)):
        raise ValueError('RESOURCE_VECTOR_SYNC_PLAN_REQUIRED')
    receipts, complete = [], True
    for index in plan['indexes']:
        expected = index['upsert']
        if fingerprint(expected) != index['vectorsSha256']:
            raise ValueError('RESOURCE_VECTOR_SYNC_PLAN_CHANGED')
        actual = candidates[index['dimensions']]
        if not isinstance(actual,list) or any(not isinstance(row,dict) or not isinstance(row.get('id'),str) for row in actual):
            raise ValueError('RESOURCE_VECTOR_SYNC_READBACK_INVALID')
        normalized = [{key:value for key,value in row.items() if key!='namespace'} if row.get('namespace') in (None,'') else row for row in actual]
        if len({row['id'] for row in normalized}) != len(normalized):
            raise ValueError('RESOURCE_VECTOR_SYNC_DUPLICATE_ID')
        normalized.sort(key=lambda row:row['id'])
        verified = fingerprint(normalized) == index['vectorsSha256']
        complete = complete and verified
        receipts.append({'dimensions':index['dimensions'],'count':len(normalized),'vectorsSha256':fingerprint(normalized),
                         'verified':verified,'deferredPending':len(index['deferred'])})
    return {'verified':complete,'indexes':receipts,'modelCallsMade':False}
