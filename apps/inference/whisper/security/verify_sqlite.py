"""Check the exact SQLite library and absence of its CLI in the final image."""
from pathlib import Path
import ctypes
import hashlib
import sqlite3

assert sqlite3.sqlite_version == '3.54.1', sqlite3.sqlite_version
assert 'Version: 3.54.1-0videoq1\n' in Path('/var/lib/dpkg/status.d/libsqlite3-0').read_text()
assert not any(Path(root, 'sqlite3').exists() for root in ('/bin', '/usr/bin', '/usr/local/bin', '/app/.venv/bin'))
with sqlite3.connect(':memory:') as db:
    assert db.execute("SELECT sqlite_compileoption_used('ENABLE_FTS5')").fetchone() == (1,)
    assert db.execute("SELECT sqlite_compileoption_used('ENABLE_SESSION')").fetchone() == (0,)
    # Regression from upstream commit e1c9934f9f11a499029abb020ea715a08970da80.
    db.execute('CREATE VIRTUAL TABLE docs USING fts5(text, detail=none)')
    db.executemany('INSERT INTO docs(rowid, text) VALUES (?, ?)',
                   [(rowid, 'ab') for rowid in range(1, 56)] + [(-9223372036854775808, 'abc')])
    assert db.execute("SELECT count(*) FROM docs('a*')").fetchone() == (56,)
library = ctypes.CDLL('libsqlite3.so.0')
assert not hasattr(library, 'sqlite3changeset_apply')
assert not hasattr(library, 'sqlite3session_create')
# Public-domain vendor regression for CVE-2026-119374, from upstream commit
# d9de6eedbe918c074c7556400fa21df5960704d9, fts5corruptB.test cases4.0/4.1.
fixture = Path('/app/fts5-secure-delete.db').read_bytes()
assert len(fixture) == 5120
assert hashlib.sha256(fixture).hexdigest() == '6403bc6c08deee687c69e6d05c680a443f7d994bda19071131db0bd196538fa3'
with sqlite3.connect(':memory:', isolation_level=None) as db:
    # Match the upstream Tcl test's autocommit. FTS5 flushes its pending secure
    # delete at transaction commit; Python's implicit transaction defers the
    # corruption result until after execute() unless autocommit is selected.
    db.deserialize(fixture)
    assert db.execute("SELECT count(*) FROM sqlite_schema WHERE name='t' AND sql LIKE '%fts5%'").fetchone() == (1,)
    assert db.execute("SELECT v FROM t_config WHERE k='secure-delete'").fetchone() == (1,)
    assert db.execute('SELECT count(*) FROM t_content WHERE id=1').fetchone() == (1,)
    try:
        db.execute('DELETE FROM t WHERE rowid = 1')
    except sqlite3.DatabaseError as error:
        assert error.sqlite_errorcode & 0xff == sqlite3.SQLITE_CORRUPT
    else:
        raise AssertionError('Corrupted secure-delete index must be rejected')
print('SQLite 3.54.1 verified; secure-delete corruption rejected, FTS5 retained, CLI/session extension absent')
