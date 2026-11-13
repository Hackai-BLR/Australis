-- The university a person belongs to and whether they administer it, as the platform
-- reports them. `university` is the platform's university id, opaque to the kernel.
ALTER TABLE core_users ADD COLUMN university TEXT;
ALTER TABLE core_users ADD COLUMN administers_university INTEGER NOT NULL DEFAULT 0
    CHECK (administers_university IN (0, 1));

-- The university a campus belongs to, copied from its creator when it is created. NULL for
-- a campus that no university owns (made by the owner, or before this column existed).
ALTER TABLE core_campuses ADD COLUMN university TEXT;
CREATE INDEX core_campuses_university ON core_campuses (university);
