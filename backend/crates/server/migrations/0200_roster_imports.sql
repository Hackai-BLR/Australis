-- Roster import previews. A preview keeps only the name and the email of each row (every
-- other column of the file is dropped at parse time) and is purged on confirm or discard.
CREATE TABLE roster_imports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    campus_id  INTEGER NOT NULL REFERENCES core_campuses (id),
    created_by INTEGER NOT NULL REFERENCES core_users (id),
    status     TEXT    NOT NULL DEFAULT 'preview'
               CHECK (status IN ('preview', 'confirmed', 'discarded')),
    source     TEXT    NOT NULL CHECK (source IN ('xlsx', 'csv', 'text')),
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    closed_at  TEXT
);
CREATE INDEX roster_imports_campus ON roster_imports (campus_id, id);

CREATE TABLE roster_import_rows (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES roster_imports (id),
    line_no   INTEGER NOT NULL,
    full_name TEXT    NOT NULL,
    email     TEXT    NOT NULL
);
CREATE INDEX roster_import_rows_import ON roster_import_rows (import_id, line_no);
