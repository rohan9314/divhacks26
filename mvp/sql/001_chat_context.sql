-- MVP chat memory: the last shared location and a few recent lines per chat.
-- Lives in its own schema so analytics queries over public.* never touch it.
-- space_id is the channel's chat id; phone numbers are never stored here.
CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.chat_context (
    space_id     text        PRIMARY KEY,
    last_lat     double precision,
    last_lng     double precision,
    last_label   text,
    location_at  timestamptz,
    recent       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
