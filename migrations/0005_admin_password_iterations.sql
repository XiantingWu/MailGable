-- Relax the admins.password_iterations CHECK constraint.
--
-- Production workerd caps PBKDF2 iterations at 100,000 (cloudflare/workerd#1346)
-- and the Workers Free plan limits CPU time to 10ms per request, which fits
-- roughly 8,000 iterations of PBKDF2-SHA-256. The original CHECK
-- (BETWEEN 50000 AND 1000000) was sized around the old 600,000 default, so a
-- bootstrap with 8,000 iterations would violate it. SQLite cannot alter a
-- CHECK constraint, so the table is rebuilt in place. admins is empty at this
-- point (bootstrap has not run), so no data or foreign-key rows are affected.

PRAGMA foreign_keys = OFF;

CREATE TABLE admins_rebuilt (
  admin_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK(password_iterations BETWEEN 1000 AND 100000),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

INSERT INTO admins_rebuilt(admin_id,email,password_hash,password_salt,password_iterations,disabled,created_at,updated_at,last_login_at)
SELECT admin_id,email,password_hash,password_salt,password_iterations,disabled,created_at,updated_at,last_login_at
  FROM admins;

DROP TABLE admins;

ALTER TABLE admins_rebuilt RENAME TO admins;

PRAGMA foreign_keys = ON;