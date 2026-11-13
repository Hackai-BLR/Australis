-- Per-campus overrides of the global rules in core_settings. A row exists only while the
-- campus overrides the key; deleting it returns the campus to the inherited value.
CREATE TABLE campus_settings (
    campus_id  INTEGER NOT NULL REFERENCES core_campuses (id),
    key        TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_by INTEGER NOT NULL REFERENCES core_users (id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (campus_id, key)
);

-- The global default of the attendance rule: an unconfirmed guess, like the grading rules.
INSERT OR IGNORE INTO core_settings (scope, key, value_json) VALUES
    ('global', 'attendance.rule', '{"min_rate_percent":75,"confirmed":false}');
