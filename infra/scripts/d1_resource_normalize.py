"""Make an exported SQL stream importable without changing its final SQLite state.

Table/index definitions precede parent-ordered data. Oversized literals use a
private transient chunk table, keeping each SQL statement below D1's limit.
The caller must validate the complete resulting dump against its source proof.
"""
import graphlib
import re
import sqlite3
from pathlib import Path
import tempfile

MAX_STATEMENT = 80000
CHUNK_BYTES = 16000
AUX = '__videoq_resource_import_chunks'
LITERAL = re.compile(r"[xX]'[0-9A-Fa-f]*'|'(?:[^']|'')*'")
TABLE = r'(?:"([^"]+)"|([A-Za-z0-9_]+))'


def statements(path):
    pending = ''
    with Path(path).open(encoding='utf-8', errors='strict') as handle:
        for line in handle:
            pending += line
            if sqlite3.complete_statement(pending):
                yield pending
                pending = ''
    if pending.strip():
        raise ValueError('RESOURCE_NORMALIZE_TRAILING_SQL')


def chunk_statement(statement, db):
    if len(statement.encode()) <= MAX_STATEMENT:
        return [], statement, []
    prefix, suffix, pieces, cursor, slot = [], [], [], 0, 0
    for match in LITERAL.finditer(statement):
        token = match.group()
        if len(token.encode()) < 12000:
            continue
        value = bytes.fromhex(token[2:-1]) if token[:2].lower() == "x'" else token[1:-1].replace("''", "'")
        if not isinstance(value, (str, bytes)):
            raise ValueError('RESOURCE_NORMALIZE_LITERAL_TYPE')
        raw = value.encode('utf-8') if isinstance(value, str) else value
        for part, offset in enumerate(range(0, len(raw), CHUNK_BYTES)):
            chunk = raw[offset:offset + CHUNK_BYTES].hex()
            prefix.append(f'INSERT INTO "{AUX}" VALUES ({slot},{part},X\'{chunk}\');\n')
        expression = (f'(SELECT group_concat(CAST(value AS TEXT),\'\') FROM '
                      f'(SELECT value FROM "{AUX}" WHERE slot={slot} ORDER BY part))')
        if isinstance(value, bytes):
            expression = 'CAST(' + expression + ' AS BLOB)'
        pieces.extend((statement[cursor:match.start()], expression))
        cursor, slot = match.end(), slot + 1
    pieces.append(statement[cursor:])
    rewritten = ''.join(pieces)
    if not slot or len(rewritten.encode()) > MAX_STATEMENT:
        raise ValueError('RESOURCE_NORMALIZE_STATEMENT_LIMIT')
    suffix.append(f'DELETE FROM "{AUX}";\n')
    return prefix, rewritten, suffix


def normalize_sql(source, destination):
    source, destination = Path(source), Path(destination)
    if source.resolve() == destination.resolve() or destination.exists():
        raise ValueError('RESOURCE_NORMALIZE_DISTINCT_NEW_FILE_REQUIRED')
    db = sqlite3.connect(':memory:')
    db.enable_load_extension(False)
    from d1_resource_dump import authorize
    db.set_authorizer(authorize)
    tables, indexes, triggers, pragmas, counts = [], [], [], [], {'statements': 0, 'chunkedRows': 0}
    with tempfile.TemporaryDirectory(prefix='normalize-', dir=destination.parent) as work:
        streams, paths = {}, {}
        try:
            for statement in statements(source):
                counts['statements'] += 1
                clean = re.sub(r'^\s*(?:--[^\n]*\n\s*)*', '', statement)
                if re.match(r'(?:BEGIN(?:\s+TRANSACTION)?|COMMIT)\s*;\s*$', clean, re.I):
                    continue
                elif re.match(r'PRAGMA\s+defer_foreign_keys\s*=\s*(?:TRUE|ON|1)\s*;\s*$', clean, re.I):
                    pragmas.append(statement)
                elif re.match(r'CREATE\s+TABLE\b', clean, re.I):
                    tables.append(statement)
                elif re.match(r'CREATE\s+(?:UNIQUE\s+)?(?:INDEX|VIEW)\b', clean, re.I):
                    indexes.append(statement)
                elif re.match(r'CREATE\s+TRIGGER\b', clean, re.I):
                    triggers.append(statement)
                else:
                    match = re.match(r'\s*(?:INSERT\s+INTO|DELETE\s+FROM)\s+' + TABLE, clean, re.I)
                    if not match:
                        raise ValueError('RESOURCE_NORMALIZE_STATEMENT_REFUSED')
                    name = match.group(1) or match.group(2)
                    if name not in streams:
                        path = Path(work) / (str(len(streams)) + '.sql')
                        paths[name] = path
                        streams[name] = path.open('x', encoding='utf-8')
                        path.chmod(0o600)
                    before, rewritten, after = chunk_statement(statement, db)
                    counts['chunkedRows'] += bool(before)
                    for item in [*before, rewritten, *after]:
                        streams[name].write(item)
            for handle in streams.values():
                handle.close()
            for statement in [*tables, *indexes]:
                if len(statement.encode()) > MAX_STATEMENT:
                    raise ValueError('RESOURCE_NORMALIZE_SCHEMA_LIMIT')
                db.execute(statement)
            db.set_authorizer(None)
            names = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
            if AUX in names:
                raise ValueError('RESOURCE_NORMALIZE_AUX_CONFLICT')
            dependencies = {name: tuple(sorted({row[2] for row in db.execute('PRAGMA foreign_key_list("' + name.replace('"', '""') + '")')})) for name in names}
            order = list(graphlib.TopologicalSorter(dependencies).static_order())
            order = [name for name in order if name != 'sqlite_sequence'] + ['sqlite_sequence']
            if any(name not in names for name in paths):
                raise ValueError('RESOURCE_NORMALIZE_UNKNOWN_TABLE')
            with destination.open('x', encoding='utf-8') as output:
                destination.chmod(0o600)
                for statement in [*tables, *indexes]:
                    output.write(statement)
                if counts['chunkedRows']:
                    output.write(f'CREATE TABLE "{AUX}" (slot INTEGER NOT NULL, part INTEGER NOT NULL, value BLOB NOT NULL, PRIMARY KEY(slot,part)) WITHOUT ROWID;\n')
                for statement in pragmas:
                    output.write(statement)
                for name in order:
                    if name in paths:
                        with paths[name].open(encoding='utf-8') as handle:
                            for chunk in iter(lambda: handle.read(1024 * 1024), ''):
                                output.write(chunk)
                if counts['chunkedRows']:
                    output.write(f'DROP TABLE "{AUX}";\n')
                for statement in triggers:
                    if len(statement.encode()) > MAX_STATEMENT:
                        raise ValueError('RESOURCE_NORMALIZE_TRIGGER_LIMIT')
                    output.write(statement)
        except Exception:
            if destination.exists():
                destination.unlink()
            raise
        finally:
            for handle in streams.values():
                handle.close()
            db.close()
    return counts


def normalize_import_file(files, proof, owned):
    """Seal normalized bytes before the ordinary downloaded-file journal entry."""
    import json
    import os
    import stat
    if files.inspect() != proof or not callable(owned):
        raise ValueError('RESOURCE_NORMALIZE_FILE_PROOF_REQUIRED')
    owned();files.checked()
    receipt = files.root / 'normalization.json'
    if receipt.exists():
        # A completed normalization can be read again, never replaced.
        fd = os.open(receipt, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as handle:
            info = os.fstat(handle.fileno())
            if (not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600
                    or info.st_uid != os.getuid() or info.st_size > 1024 * 1024):
                raise ValueError('RESOURCE_NORMALIZE_RECEIPT_UNSAFE')
            value = json.loads(handle.read(1024 * 1024 + 1))
        if value.get('version') != 1 or value.get('normalized') != proof:
            raise ValueError('RESOURCE_NORMALIZE_RECEIPT_CHANGED')
        owned();return proof
    source = files.root / 'source.sql'
    original = files.root / 'source-export.sql'
    output = files.root / 'source-normalized.sql'
    if original.exists() or output.exists():
        raise ValueError('RESOURCE_NORMALIZE_RECONCILIATION_REQUIRED')
    counts = normalize_sql(source, output)
    owned();files.checked()
    if files.inspect() != proof:
        output.unlink()
        raise ValueError('RESOURCE_NORMALIZE_SOURCE_CHANGED')
    os.rename(source, original)
    os.rename(output, source)
    files.sync_directory()
    normalized = files.inspect()
    value = {'version': 1, 'original': proof, 'normalized': normalized, **counts}
    fd = os.open(receipt, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle);handle.flush();os.fsync(handle.fileno())
    files.sync_directory();owned()
    return normalized
