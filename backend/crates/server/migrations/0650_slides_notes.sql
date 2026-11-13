-- Private notes of a user on one page of a presentation. Only the author ever reads them.
CREATE TABLE slides_notes (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    presentation_id INTEGER NOT NULL REFERENCES slides_presentations (id),
    user_id         INTEGER NOT NULL REFERENCES core_users (id),
    page            INTEGER NOT NULL CHECK (page >= 1),
    body            TEXT NOT NULL,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (presentation_id, user_id, page)
);
