-- The content of a campus. The kernel owns the campus identity row (core_campuses); this
-- module owns what is shown on it.
CREATE TABLE campus_documents (
    campus_id    INTEGER PRIMARY KEY REFERENCES core_campuses (id),
    template_key TEXT NOT NULL,
    content_json TEXT NOT NULL,
    -- Bumped on every save; a save must name the version it was based on.
    version      INTEGER NOT NULL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by   INTEGER NOT NULL REFERENCES core_users (id)
);

-- Every saved version, as a full snapshot, so restoring never needs a replay.
CREATE TABLE campus_revisions (
    id           INTEGER PRIMARY KEY,
    campus_id    INTEGER NOT NULL REFERENCES core_campuses (id),
    version      INTEGER NOT NULL,
    content_json TEXT NOT NULL,
    summary      TEXT NOT NULL,
    via          TEXT NOT NULL CHECK (via IN ('template', 'editor', 'ai', 'restore')),
    -- The AI proposal that produced the revision (a row of another module): a plain integer.
    proposal_id  INTEGER,
    created_by   INTEGER NOT NULL REFERENCES core_users (id),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (campus_id, version)
);
