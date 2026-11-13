-- "Report a problem" reports. `campus_id` is NULL for a report that is not about a campus; it
-- then goes to the secretary. A campus report goes to that campus's professors.
CREATE TABLE support_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    campus_id   INTEGER REFERENCES core_campuses (id),
    reporter_id INTEGER NOT NULL REFERENCES core_users (id),
    page        TEXT NOT NULL,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_by INTEGER REFERENCES core_users (id),
    resolved_at TEXT
);

CREATE INDEX support_reports_campus ON support_reports (campus_id, status);
