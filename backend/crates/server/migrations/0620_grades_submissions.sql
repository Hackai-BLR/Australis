-- Submission of a campus's grades to the secretary. No row means draft. A returned campus
-- goes back to draft and keeps the secretary's note until it is sent again.
CREATE TABLE grades_submissions (
    campus_id  INTEGER PRIMARY KEY REFERENCES core_campuses (id),
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'checked')),
    note       TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES core_users (id)
);
