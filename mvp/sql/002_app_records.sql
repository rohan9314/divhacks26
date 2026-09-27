-- Website accounts, moved off DeepSpace. One generic record table so the account logic ported from
-- backend/src/domain/site.ts runs unchanged. Collections: site_users, site_codes, site_challenges,
-- site_sessions, site_waitlist.
--
-- site_users holds the raw phone and email (needed to sign in and to text people). It lives in the
-- `app` schema with chat memory; analytics tables in public.* never join it. Codes, challenges and
-- session tokens are stored only as hashes.
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.records (
    collection  text        NOT NULL,
    record_id   text        NOT NULL DEFAULT gen_random_uuid()::text,
    data        jsonb       NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (collection, record_id)
);

-- The primary key already indexes `collection`; this serves the `data @> {...}` lookups.
CREATE INDEX IF NOT EXISTS app_records_data_idx ON app.records USING gin (data jsonb_path_ops);

-- The uniqueness DeepSpace enforced with `uniqueOn`. Keep in sync with packages/accounts/src/testing.ts.
CREATE UNIQUE INDEX IF NOT EXISTS app_records_site_users_phone
    ON app.records ((data->>'phone')) WHERE collection = 'site_users';
CREATE UNIQUE INDEX IF NOT EXISTS app_records_site_codes_key
    ON app.records ((data->>'key')) WHERE collection = 'site_codes';
CREATE UNIQUE INDEX IF NOT EXISTS app_records_site_challenges_token
    ON app.records ((data->>'tokenHash')) WHERE collection = 'site_challenges';
CREATE UNIQUE INDEX IF NOT EXISTS app_records_site_sessions_token
    ON app.records ((data->>'tokenHash')) WHERE collection = 'site_sessions';
CREATE UNIQUE INDEX IF NOT EXISTS app_records_site_waitlist_email
    ON app.records ((data->>'email')) WHERE collection = 'site_waitlist';
