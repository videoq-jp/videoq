"""Compare the actual core ZIP with private, read-only model-store snapshots.

Run on the disposable CI host. Private records arrive on stdin; neither records,
archive paths nor exception messages are printed. No network or service access.
"""
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile

COLLECTIONS = ('checkpoints', 'checkpoint_blobs', 'checkpoint_writes')
MAX_BYTES = 64 * 1024 * 1024


def require(value):
    if not value:
        raise ValueError('Private model archive verification failed')


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def verify_archive(path, expected):
    require(isinstance(expected, dict) and set(expected) == {'context', 'conversationId', 'records'})
    require(isinstance(expected['context'], str) and re.fullmatch(r'[1-9][0-9]{0,17}', expected['context']))
    require(isinstance(expected['conversationId'], str) and
            re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', expected['conversationId']))
    require(isinstance(expected['records'], dict) and set(expected['records']) == set(COLLECTIONS))
    for rows in expected['records'].values():
        require(isinstance(rows, list) and 0 < len(rows) <= 10000 and all(isinstance(row, dict) for row in rows))
    actual = {key: [] for key in COLLECTIONS}
    path = Path(path)
    require(path.is_file() and 0 < path.stat().st_size <= MAX_BYTES)
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        require(len(members) <= 10000 and sum(member.file_size for member in members) <= MAX_BYTES)
        require(len({member.filename for member in members}) == len(members))
        fragments = set()
        referenced = set()

        def record(collection, value):
            require(isinstance(value, dict) and value.get('context') == expected['context'])
            data = value.get('data')
            require(isinstance(data, dict) and data.get('conversationId') == expected['conversationId'])
            actual[collection].append(data)

        for member in members:
            parts = member.filename.split('/')
            collection = parts[-2] if len(parts) >= 2 else ''
            if 'VideoQ' not in parts or collection not in COLLECTIONS or member.is_dir():
                continue
            if member.filename.endswith('.ndjson'):
                for line in archive.read(member).decode('utf8').splitlines():
                    if line.strip():
                        record(collection, json.loads(line))
            elif member.filename.endswith('-manifest.json'):
                # Moodle writes exceptionally large complete records as numbered
                # UTF-8 parts. Reassemble and verify the real manifest checksum.
                manifest = json.loads(archive.read(member))
                count = manifest.get('fragments')
                require(type(count) is int and 0 < count <= 10000 and manifest.get('context') == expected['context'])
                prefix = member.filename[:-len('-manifest.json')]
                names = [prefix + '-part-' + str(index) + '.txt' for index in range(1, count + 1)]
                require(not referenced.intersection(names))
                referenced.update(names)
                raw = b''.join(archive.read(name) for name in names)
                text = raw.decode('utf8')
                require(manifest.get('encoding') == 'UTF-8' and type(manifest.get('characters')) is int and
                        len(text) == manifest['characters'] and hashlib.sha256(raw).hexdigest() == manifest.get('sha256'))
                record(collection, {'context': manifest['context'], 'data': json.loads(text)})
            elif re.fullmatch(r'[1-9][0-9]*-part-[1-9][0-9]*\.txt', parts[-1]):
                fragments.add(member.filename)
        require(fragments == referenced)
    for collection in COLLECTIONS:
        require(sorted(map(canonical, actual[collection])) == sorted(map(canonical, expected['records'][collection])))
    return {'modelRecordsMatched': True, 'counts': {key: len(rows) for key, rows in actual.items()},
            'archiveSha256': hashlib.sha256(path.read_bytes()).hexdigest()}


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 2)
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        require(len(raw) <= MAX_BYTES)
        result = verify_archive(sys.argv[1], json.loads(raw))
    except Exception:
        print('{"status":"failed"}')
        sys.exit(1)
    print(json.dumps(result))
