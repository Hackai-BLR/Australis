-- Gradebook: assessment items per campus and one score per item and student.
-- Items are archived, never deleted. A score of NULL means "no grade yet".
CREATE TABLE grades_items (
    id          INTEGER PRIMARY KEY,
    campus_id   INTEGER NOT NULL REFERENCES core_campuses (id),
    title       TEXT NOT NULL,
    weight      REAL NOT NULL DEFAULT 1 CHECK (weight >= 0),
    position    INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX grades_items_campus ON grades_items (campus_id, position, id);

CREATE TABLE grades_entries (
    item_id    INTEGER NOT NULL REFERENCES grades_items (id),
    student_id INTEGER NOT NULL REFERENCES core_users (id),
    score      REAL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES core_users (id),
    PRIMARY KEY (item_id, student_id)
);
CREATE INDEX grades_entries_student ON grades_entries (student_id);

CREATE TRIGGER grades_items_no_delete BEFORE DELETE ON grades_items
BEGIN
    SELECT RAISE(ABORT, 'grades_items rows are never deleted; archive the item instead');
END;
