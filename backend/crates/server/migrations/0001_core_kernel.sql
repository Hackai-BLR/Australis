-- Kernel tables. They belong to australis-core; modules reach them only through
-- australis_core functions and may reference them with foreign keys.
-- Timestamps are UTC text from datetime('now').

CREATE TABLE core_users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name     TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('student', 'professor', 'secretary')),
    -- NULL until the person sets a password through an invite.
    password_hash TEXT,
    status        TEXT NOT NULL CHECK (status IN ('invited', 'active', 'suspended')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE core_sessions (
    -- SHA-256 of the random token held in the cookie.
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES core_users (id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);
CREATE INDEX core_sessions_user ON core_sessions (user_id);

CREATE TABLE core_invites (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES core_users (id),
    created_by INTEGER REFERENCES core_users (id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    revoked_at TEXT
);
CREATE INDEX core_invites_user ON core_invites (user_id);

-- One campus is one course. Content lives in the campus module's own tables.
CREATE TABLE core_campuses (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    owner_id   INTEGER NOT NULL REFERENCES core_users (id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE core_members (
    campus_id        INTEGER NOT NULL REFERENCES core_campuses (id),
    user_id          INTEGER NOT NULL REFERENCES core_users (id),
    role             TEXT NOT NULL CHECK (role IN ('professor', 'guest', 'student')),
    status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    suspended_at     TEXT,
    suspended_by     INTEGER REFERENCES core_users (id),
    suspended_reason TEXT,
    PRIMARY KEY (campus_id, user_id)
);
CREATE INDEX core_members_user ON core_members (user_id);

-- A removed person is suspended, never deleted.
CREATE TRIGGER core_users_no_delete BEFORE DELETE ON core_users
BEGIN
    SELECT RAISE(ABORT, 'core_users rows are never deleted; suspend the user instead');
END;

CREATE TRIGGER core_members_no_delete BEFORE DELETE ON core_members
BEGIN
    SELECT RAISE(ABORT, 'core_members rows are never deleted; suspend the member instead');
END;

-- Who changed what, when and why. Append-only.
CREATE TABLE core_audit_log (
    id              INTEGER PRIMARY KEY,
    actor_id        INTEGER REFERENCES core_users (id),
    campus_id       INTEGER REFERENCES core_campuses (id),
    entity          TEXT NOT NULL,
    entity_id       INTEGER NOT NULL,
    -- The person the change is about (the student of a grade, the suspended member), if any.
    subject_user_id INTEGER REFERENCES core_users (id),
    action          TEXT NOT NULL,
    before_json     TEXT,
    after_json      TEXT,
    reason          TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX core_audit_log_campus ON core_audit_log (campus_id, entity, id);
CREATE INDEX core_audit_log_entity ON core_audit_log (entity, entity_id);

CREATE TRIGGER core_audit_log_no_update BEFORE UPDATE ON core_audit_log
BEGIN
    SELECT RAISE(ABORT, 'core_audit_log is append-only');
END;

CREATE TRIGGER core_audit_log_no_delete BEFORE DELETE ON core_audit_log
BEGIN
    SELECT RAISE(ABORT, 'core_audit_log is append-only');
END;

-- Rules that are settings, not constants. Only the 'global' scope is used for now.
CREATE TABLE core_settings (
    scope      TEXT NOT NULL DEFAULT 'global',
    key        TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_by INTEGER REFERENCES core_users (id),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (scope, key)
);

-- The grading defaults are a guess (1 to 10, pass mark 4, weighted mean). "confirmed": false
-- means the program has not confirmed them; the screens must say so.
INSERT INTO core_settings (scope, key, value_json) VALUES
    ('global', 'grading.scale', '{"min":1,"max":10,"pass":4,"confirmed":false}'),
    ('global', 'grading.final_rule', '{"kind":"weighted_mean","confirmed":false}'),
    ('global', 'ai.shaping.daily_quota', '20'),
    ('global', 'app.utc_offset_minutes', '-180');

-- One row per AI call (or refused call), for the cost statement.
CREATE TABLE core_ai_usage (
    id            INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES core_users (id),
    campus_id     INTEGER REFERENCES core_campuses (id),
    feature       TEXT NOT NULL,
    provider      TEXT NOT NULL,
    model         TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL CHECK (status IN ('ok', 'error', 'refused')),
    -- 1 when the reply came from a placeholder provider.
    simulated     INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX core_ai_usage_user ON core_ai_usage (user_id, feature, created_at);

-- Calls reserved per user, feature and local day.
CREATE TABLE core_ai_quota (
    user_id INTEGER NOT NULL REFERENCES core_users (id),
    feature TEXT NOT NULL,
    day     TEXT NOT NULL,
    calls   INTEGER NOT NULL CHECK (calls >= 0),
    PRIMARY KEY (user_id, feature, day)
);
