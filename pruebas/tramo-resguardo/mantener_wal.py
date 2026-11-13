import sqlite3
import sys

con = sqlite3.connect(sys.argv[1], isolation_level=None)
con.execute("PRAGMA journal_mode=WAL")
con.execute("PRAGMA wal_autocheckpoint=0")
con.execute("BEGIN")
for i in range(50):
    con.execute("INSERT INTO auditoria(quien, que, datos, cuando) VALUES (?, ?, ?, ?)", (2, "en-wal-%d" % i, bytes([i]), "2026-11-10T04:29:00Z"))
con.execute("COMMIT")
print("listo", flush=True)
sys.stdin.read()
con.close()
