-- Synced presentations. `class_id` points at a class of the classes module: a plain integer
-- on purpose, modules never reference each other's tables.
CREATE TABLE slides_presentations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    campus_id       INTEGER NOT NULL REFERENCES core_campuses (id),
    class_id        INTEGER,
    title           TEXT NOT NULL,
    source_filename TEXT NOT NULL,
    pdf_key         TEXT NOT NULL,
    page_count      INTEGER NOT NULL CHECK (page_count >= 1),
    created_by      INTEGER NOT NULL REFERENCES core_users (id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX slides_presentations_campus ON slides_presentations (campus_id);

CREATE TABLE slides_live (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    presentation_id INTEGER NOT NULL REFERENCES slides_presentations (id),
    campus_id       INTEGER NOT NULL REFERENCES core_campuses (id),
    status          TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'ended')),
    current_page    INTEGER NOT NULL DEFAULT 1 CHECK (current_page >= 1),
    -- Grows by one on every change; followers ignore anything older than what they hold.
    seq             INTEGER NOT NULL DEFAULT 0,
    started_by      INTEGER NOT NULL REFERENCES core_users (id),
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at        TEXT
);

-- One live session per campus.
CREATE UNIQUE INDEX slides_live_one_per_campus ON slides_live (campus_id) WHERE status = 'live';
