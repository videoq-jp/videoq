"""Read-only snapshot of the current VideoQ Vectorize indexes for renaming.

No index writes, model calls, binding updates or credential retrieval. The caller
supplies a Cloudflare token in its environment. A stable read is not a writer
fence: perform the final copy only after draining all production writers.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import sys
import urllib.parse
import urllib.request

ACCOUNT = '12daec56fdba43f677f2766ee26a5a39'
SOURCES = {1536: 'videoq-scenes-migration-v3-1536', 768: 'videoq-scenes-migration-v3-768'}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def inventory(call, base):
    ids, cursors, cursor, total = [], set(), None, None
    for _ in range(10000):
        query = {'count': 1000}
        if cursor:
            query['cursor'] = cursor
        page = call('GET', base + '/list?' + urllib.parse.urlencode(query))
        if (type(page.get('count')) is not int or type(page.get('totalCount')) is not int
                or page['totalCount'] < 0 or type(page.get('isTruncated')) is not bool
                or not isinstance(page.get('vectors'), list) or page['count'] != len(page['vectors'])):
            raise ValueError('INVALID_VECTOR_PAGE')
        if total is None:
            total = page['totalCount']
        if total != page['totalCount']:
            raise ValueError('SOURCE_COUNT_CHANGED')
        for item in page['vectors']:
            identifier = item.get('id')
            if not isinstance(identifier, str) or not 1 <= len(identifier) <= 64:
                raise ValueError('INVALID_VECTOR_ID')
            ids.append(identifier)
        if not page['isTruncated']:
            break
        cursor = page.get('nextCursor')
        if not isinstance(cursor, str) or not cursor or cursor in cursors:
            raise ValueError('INVALID_VECTOR_CURSOR')
        cursors.add(cursor)
    else:
        raise ValueError('VECTOR_PAGE_LIMIT')
    if len(ids) != total or len(set(ids)) != len(ids):
        raise ValueError('INCOMPLETE_VECTOR_INVENTORY')
    return sorted(ids)


def snapshot_index(call, dimensions, index_name=None):
    selected = SOURCES[dimensions] if index_name is None else index_name
    if selected not in (SOURCES[dimensions], f'videoq-prod-scenes-{dimensions}'):
        raise ValueError('FIXED_VECTOR_SNAPSHOT_INDEX_REQUIRED')
    base = f'accounts/{ACCOUNT}/vectorize/v2/indexes/{selected}'
    before = call('GET', base + '/info')
    if before.get('dimensions') != dimensions or type(before.get('vectorCount')) is not int:
        raise ValueError('INVALID_INDEX_INFO')
    ids = inventory(call, base)
    if len(ids) != before['vectorCount']:
        raise ValueError('SOURCE_COUNT_CHANGED')
    vectors = []
    for offset in range(0, len(ids), 20):
        batch = ids[offset:offset + 20]
        rows = call('POST', base + '/get_by_ids', {'ids': batch})
        if not isinstance(rows, list) or len(rows) != len(batch):
            raise ValueError('MISSING_VECTOR')
        seen = set()
        for row in rows:
            if not isinstance(row, dict) or row.get('id') not in batch or row['id'] in seen:
                raise ValueError('UNEXPECTED_VECTOR')
            seen.add(row['id'])
            values = row.get('values')
            if (not isinstance(values, list) or len(values) != dimensions
                    or any(type(v) not in (int, float) or not math.isfinite(v) for v in values)):
                raise ValueError('INVALID_VECTOR_VALUES')
            # Preserve all returned metadata and namespace fields without guessing
            # which ones are required by the current search adapter.
            if set(row) - {'id', 'values', 'metadata', 'namespace'}:
                raise ValueError('UNEXPECTED_VECTOR_FIELDS')
            # The live REST API returns null for the default namespace.
            # Upsert's optional string field represents this by omission.
            if row.get('namespace') is None:
                row = {key: value for key, value in row.items() if key != 'namespace'}
            elif not isinstance(row['namespace'], str):
                raise ValueError('INVALID_VECTOR_NAMESPACE')
            vectors.append(row)
    after = call('GET', base + '/info')
    if before != after or ids != inventory(call, base):
        raise ValueError('SOURCE_CHANGED_DURING_SNAPSHOT')
    vectors.sort(key=lambda row: row['id'])
    return vectors, {'source': selected, 'dimensions': dimensions,
                     'count': len(vectors), 'vectorsSha256': digest(vectors),
                     'sourceInfo': before, 'writerFenceProven': False}


def snapshot(call, output):
    if output.is_symlink() or not output.is_dir() or stat.S_IMODE(output.stat().st_mode) != 0o700:
        raise ValueError('PRIVATE_OUTPUT_DIRECTORY_REQUIRED')
    if any(output.iterdir()):
        raise ValueError('EMPTY_OUTPUT_DIRECTORY_REQUIRED')
    paths, receipts = [], []
    try:
        for dimensions in SOURCES:
            vectors, receipt = snapshot_index(call, dimensions)
            path = output / f'vectors-{dimensions}.private.ndjson'
            with open(path, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as f:
                paths.append(path)
                for row in vectors:
                    f.write(json.dumps(row, separators=(',', ':'), allow_nan=False) + '\n')
            receipts.append(receipt)
        proof = {'accountId': ACCOUNT, 'indexes': receipts, 'modelCallsMade': False,
                 'remoteMutations': False, 'writerFenceProven': False}
        path = output / 'snapshot-receipt.json'
        with open(path, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as f:
            paths.append(path)
            json.dump(proof, f, indent=2)
        return proof
    except BaseException:
        for path in paths:
            path.unlink(missing_ok=True)
        raise


class CloudflareReadOnly:
    def __init__(self, token):
        if not token or any(c in token for c in '\r\n\0'):
            raise ValueError('TOKEN_REQUIRED')
        self.token = token

    def __call__(self, method, path, payload=None):
        prefix = f'accounts/{ACCOUNT}/vectorize/v2/indexes/'
        allowed = any(path.startswith(prefix + name + '/') for name in SOURCES.values())
        if not allowed or not ((method == 'GET' and ('/list?' in path or path.endswith('/info')))
                               or (method == 'POST' and path.endswith('/get_by_ids'))):
            raise ValueError('READ_ONLY_ENDPOINT_REQUIRED')
        req = urllib.request.Request('https://api.cloudflare.com/client/v4/' + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            method=method, headers={'Authorization': 'Bearer ' + self.token,
                                    'Content-Type': 'application/json'})
        # Refuse redirects, which must never forward the operator token.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=30) as response:
            data = response.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            raise ValueError('RESPONSE_LIMIT')
        result = json.loads(data)
        if result.get('success') is not True:
            raise ValueError('VECTOR_READ_FAILED')
        return result['result']


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(snapshot(CloudflareReadOnly(os.environ.get('CLOUDFLARE_API_TOKEN')), args.output_dir)))
    except Exception:
        print('VECTOR_SNAPSHOT_FAILED; source data and credentials are not logged', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
