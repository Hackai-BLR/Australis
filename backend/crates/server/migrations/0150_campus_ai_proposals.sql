-- AI shaping proposals. A proposal is the AI's suggested change to a campus: the operations,
-- the document they produce (the preview) and the list of changes. It never changes the
-- campus until a professor accepts it. Rows are kept for the history; nothing deletes them.
CREATE TABLE campus_ai_proposals (
    id               INTEGER PRIMARY KEY,
    campus_id        INTEGER NOT NULL REFERENCES core_campuses (id),
    user_id          INTEGER NOT NULL REFERENCES core_users (id),
    instruction      TEXT NOT NULL,
    -- pending: waiting for a decision. empty: the AI proposed nothing (its reply is in
    -- message). accepted / rejected: decided. stale: the campus changed after the proposal.
    status           TEXT NOT NULL CHECK (status IN ('pending', 'empty', 'accepted', 'rejected', 'stale')),
    -- What the AI said, shown to the professor.
    message          TEXT NOT NULL,
    -- The campus document version the operations were computed on.
    base_version     INTEGER NOT NULL,
    ops_json         TEXT NOT NULL,
    changes_json     TEXT NOT NULL,
    preview_json     TEXT NOT NULL,
    simulated        INTEGER NOT NULL DEFAULT 0,
    -- The usage-log row (core_ai_usage) of the provider call: a plain integer.
    usage_id         INTEGER,
    -- The campus version created by accepting the proposal.
    revision_version INTEGER,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    decided_by       INTEGER REFERENCES core_users (id),
    decided_at       TEXT
);
CREATE INDEX campus_ai_proposals_campus ON campus_ai_proposals (campus_id, id);

-- Prices (USD per million tokens) a real provider would charge, used only to estimate the
-- running cost on the usage screen. The placeholder provider costs nothing.
INSERT OR IGNORE INTO core_settings (scope, key, value_json) VALUES
    ('global', 'ai.shaping.price_input_usd_per_mtok', '3.0'),
    ('global', 'ai.shaping.price_output_usd_per_mtok', '15.0');
