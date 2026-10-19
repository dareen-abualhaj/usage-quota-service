-- Idempotent: runs on every service start.
CREATE TABLE IF NOT EXISTS accounts (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  api_key_hash  TEXT NOT NULL UNIQUE,          -- SHA-256 of the API key; the key itself is never stored
  plan_id       INT  NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plans (
  id                 SERIAL PRIMARY KEY,
  account_id         INT REFERENCES accounts(id),   -- NULL = predefined (global, read-only)
  kind               TEXT NOT NULL CHECK (kind IN ('account','user')),
  name               TEXT NOT NULL,
  monthly_allowance  BIGINT NOT NULL CHECK (monthly_allowance >= 0),
  max_per_request    BIGINT NOT NULL CHECK (max_per_request > 0),
  is_predefined      BOOLEAN NOT NULL DEFAULT false,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((is_predefined AND account_id IS NULL) OR (NOT is_predefined AND account_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS plans_unique_name ON plans (COALESCE(account_id, 0), kind, name);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_plan_fk') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_plan_fk FOREIGN KEY (plan_id) REFERENCES plans(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  account_id   INT NOT NULL REFERENCES accounts(id),
  external_id  TEXT NOT NULL,                       -- the id the calling application uses
  plan_id      INT NOT NULL REFERENCES plans(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, external_id)
);

-- One row per (entity, UTC month). Counters only ever change through /consume, under row locks.
CREATE TABLE IF NOT EXISTS account_usage (
  account_id INT  NOT NULL REFERENCES accounts(id),
  month      TEXT NOT NULL,                          -- 'YYYY-MM' (UTC)
  consumed   BIGINT NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  PRIMARY KEY (account_id, month)
);
CREATE TABLE IF NOT EXISTS user_usage (
  user_id  INT  NOT NULL REFERENCES users(id),
  month    TEXT NOT NULL,
  consumed BIGINT NOT NULL DEFAULT 0 CHECK (consumed >= 0),
  PRIMARY KEY (user_id, month)
);

-- Every decision (accepted or rejected). UNIQUE(account_id, request_id) is the idempotency guard.
CREATE TABLE IF NOT EXISTS requests (
  id              BIGSERIAL PRIMARY KEY,
  account_id      INT  NOT NULL REFERENCES accounts(id),
  user_id         INT  NOT NULL REFERENCES users(id),
  request_id      TEXT NOT NULL,
  units           BIGINT NOT NULL CHECK (units > 0),
  month           TEXT NOT NULL,
  accepted        BOOLEAN NOT NULL DEFAULT false,
  rejected_scope  TEXT CHECK (rejected_scope IN ('account','user')),
  rejected_rule   TEXT CHECK (rejected_rule IN ('monthly_allowance','max_per_request')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, request_id)
);
CREATE INDEX IF NOT EXISTS requests_account_id_idx ON requests (account_id, id DESC);
CREATE INDEX IF NOT EXISTS requests_user_idx ON requests (user_id, id DESC);

-- Predefined plans (read-only through the API). Re-running never overwrites them.
INSERT INTO plans (account_id, kind, name, monthly_allowance, max_per_request, is_predefined) VALUES
  (NULL, 'account', 'Starter',  1000,   100,  true),
  (NULL, 'account', 'Pro',      100000, 1000, true),
  (NULL, 'user',    'Basic',    100,    10,   true),
  (NULL, 'user',    'Premium',  1000,   100,  true)
ON CONFLICT DO NOTHING;
