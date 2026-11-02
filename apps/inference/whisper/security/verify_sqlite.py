"""Check the exact SQLite library and absence of its CLI in the final image."""
from pathlib import Path
import sqlite3

assert sqlite3.sqlite_version == '3.54.1', sqlite3.sqlite_version
assert 'Version: 3.54.1-0videoq1\n' in Path('/var/lib/dpkg/status.d/libsqlite3-0').read_text()
assert not any(Path(root, 'sqlite3').exists() for root in ('/bin', '/usr/bin', '/usr/local/bin', '/app/.venv/bin'))
with sqlite3.connect(':memory:') as db:
    assert db.execute("SELECT sqlite_compileoption_used('ENABLE_FTS5')").fetchone() == (1,)
    # Regression from upstream commit e1c9934f9f11a499029abb020ea715a08970da80.
    db.execute('CREATE VIRTUAL TABLE docs USING fts5(text, detail=none)')
    db.executemany('INSERT INTO docs(rowid, text) VALUES (?, ?)',
                   [(rowid, 'ab') for rowid in range(1, 56)] + [(-9223372036854775808, 'abc')])
    assert db.execute("SELECT count(*) FROM docs('a*')").fetchone() == (56,)
print('SQLite 3.54.1 library verified; FTS5 retained, SQLite CLI absent')
