-- Classes module: the professor's Zoom connection and one row per class meeting.

-- A professor "connects Zoom once". With the placeholder provider this only records the
-- connection; a real provider would keep its OAuth tokens here.
CREATE TABLE classes_zoom_links (
    user_id      INTEGER PRIMARY KEY REFERENCES core_users (id),
    provider     TEXT NOT NULL,
    connected_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE classes_classes (
    id               INTEGER PRIMARY KEY,
    campus_id        INTEGER NOT NULL REFERENCES core_campuses (id),
    title            TEXT NOT NULL,
    -- UTC, 'YYYY-MM-DD HH:MM:SS'.
    starts_at        TEXT NOT NULL,
    duration_min     INTEGER NOT NULL CHECK (duration_min > 0),
    meeting_source   TEXT NOT NULL CHECK (meeting_source IN ('placeholder', 'manual')),
    zoom_meeting_id  TEXT,
    join_url         TEXT NOT NULL,
    -- Host link. Never sent to a student.
    start_url        TEXT,
    -- Maintained by the recordings package.
    recording_status TEXT NOT NULL DEFAULT 'none',
    ended_at         TEXT,
    created_by       INTEGER NOT NULL REFERENCES core_users (id),
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX classes_classes_campus ON classes_classes (campus_id, starts_at);
CREATE INDEX classes_classes_starts ON classes_classes (starts_at);
