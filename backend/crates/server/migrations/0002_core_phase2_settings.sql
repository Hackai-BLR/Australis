-- Settings that phase 2 features read. Campuses may override the attendance rule (scope
-- 'campus:<id>'). Both values are guesses: "confirmed": false means the program has not
-- confirmed them, and the screens must say so.
INSERT OR IGNORE INTO core_settings (scope, key, value_json) VALUES
    ('global', 'attendance.rule', '{"min_percent":75,"confirmed":false}'),
    ('global', 'ai.summary.daily_quota', '20');
