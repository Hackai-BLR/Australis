-- Class summary: one row per class. The AI writes a draft; only an approved summary is
-- visible to students. Editing an approved summary turns it back into a draft.
CREATE TABLE classes_summaries (
    class_id     INTEGER PRIMARY KEY REFERENCES classes_classes (id),
    body         TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
    simulated    INTEGER NOT NULL DEFAULT 1,
    model        TEXT NOT NULL DEFAULT '',
    usage_id     INTEGER,
    generated_by INTEGER NOT NULL REFERENCES core_users (id),
    generated_at TEXT NOT NULL DEFAULT (datetime('now')),
    edited_by    INTEGER REFERENCES core_users (id),
    edited_at    TEXT,
    approved_by  INTEGER REFERENCES core_users (id),
    approved_at  TEXT
);
