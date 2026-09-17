-- Password scheme versioning and audit correlation index fix.
--
-- 1. admins.password_scheme identifies the verifier algorithm so future
--    KDF upgrades can coexist with legacy hashes:
--      'pbkdf2-sha256+hmac-sha256-v1' -> PBKDF2-SHA256(salt) then
--                                       HMAC-SHA256(AUTH_PEPPER, key)
--    (new writes and any legacy hash that verifies are upgraded to v1)
--    any other value (pre-public rows without the column) -> legacy
--    PBKDF2-SHA256 verification, upgraded to v1 on the next successful
--    login.
--
-- 2. idx_admin_audit_request is an ordinary index, not unique: a single
--    request can legitimately produce several audit events with the same
--    correlation id.

ALTER TABLE admins ADD COLUMN password_scheme TEXT NOT NULL DEFAULT 'pbkdf2-sha256+hmac-sha256-v1';

DROP INDEX IF EXISTS idx_admin_audit_request;
CREATE INDEX IF NOT EXISTS idx_admin_audit_request ON admin_audit_log(request_id) WHERE request_id IS NOT NULL;