-- Attendance: one record per student per class.
CREATE TABLE classes_attendance (
    id         INTEGER PRIMARY KEY,
    class_id   INTEGER NOT NULL REFERENCES classes_classes (id),
    user_id    INTEGER NOT NULL REFERENCES core_users (id),
    status     TEXT NOT NULL CHECK (status IN ('present', 'absent', 'late', 'excused')),
    -- 'session' when filled from the Zoom participant list, 'manual' when typed by a teacher.
    source     TEXT NOT NULL CHECK (source IN ('session', 'manual')),
    -- Why the last change was made; empty for the first save.
    reason     TEXT,
    updated_by INTEGER NOT NULL REFERENCES core_users (id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (class_id, user_id)
);
CREATE INDEX classes_attendance_user ON classes_attendance (user_id);

-- A student who joins the meeting this many minutes after the start is marked late when
-- attendance is taken from the session. Not confirmed by any program yet.
INSERT OR IGNORE INTO core_settings (scope, key, value_json) VALUES
    ('global', 'attendance.late_after_minutes', '{"minutes": 15, "confirmed": false}');
