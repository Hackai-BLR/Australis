-- Recordings module: one row per class once the provider has published its recording.
-- The status lives on classes_classes.recording_status (none -> pending -> available ->
-- transcript_ready). Video files are never stored; only the play link and the transcript.
CREATE TABLE classes_recordings (
    class_id        INTEGER PRIMARY KEY REFERENCES classes_classes (id),
    play_url        TEXT NOT NULL,
    duration_s      INTEGER NOT NULL DEFAULT 0,
    transcript_vtt  TEXT,
    transcript_text TEXT,
    published_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
