import type { Location, Query } from "@mvp/core";

export interface ChatContext {
  lastLocation?: Location;
  recent: string[];
}

/** Per-chat memory for the MVP: the last shared location and a few recent lines. */
export interface ContextStore {
  get(spaceId: string): Promise<ChatContext>;
  recordLocation(spaceId: string, location: Location): Promise<void>;
  recordLine(spaceId: string, line: string): Promise<void>;
}

const MAX_LINES = 10;
/** A shared location older than this is treated as unknown; people move. */
const LOCATION_TTL_MS = 6 * 3_600_000;

export function createMemoryContextStore(now: () => number = Date.now): ContextStore {
  const chats = new Map<string, { location?: Location; locationAt?: number; recent: string[] }>();
  const chat = (spaceId: string) => {
    const existing = chats.get(spaceId);
    if (existing) return existing;
    const entry: { location?: Location; locationAt?: number; recent: string[] } = { recent: [] };
    chats.set(spaceId, entry);
    return entry;
  };
  return {
    async get(spaceId) {
      const entry = chat(spaceId);
      const fresh = entry.locationAt != null && now() - entry.locationAt < LOCATION_TTL_MS;
      return { ...(fresh && entry.location && { lastLocation: entry.location }), recent: [...entry.recent] };
    },
    async recordLocation(spaceId, location) {
      Object.assign(chat(spaceId), { location, locationAt: now() });
    },
    async recordLine(spaceId, line) {
      const entry = chat(spaceId);
      entry.recent = [...entry.recent, line].slice(-MAX_LINES);
    },
  };
}

/**
 * Uses `primary`, and falls back to `fallback` for any call that fails, so a database hiccup
 * degrades chat memory instead of dropping the reply.
 */
export function withFallback(
  primary: ContextStore,
  fallback: ContextStore,
  onError: (error: unknown) => void,
): ContextStore {
  // Writes go to both, so the fallback is already warm if the primary starts failing mid-conversation.
  const write = async (toPrimary: () => Promise<void>, toFallback: () => Promise<void>) => {
    await toFallback();
    await toPrimary().catch(onError);
  };
  return {
    async get(spaceId) {
      try {
        return await primary.get(spaceId);
      } catch (error) {
        onError(error);
        return fallback.get(spaceId);
      }
    },
    recordLocation: (spaceId, location) =>
      write(
        () => primary.recordLocation(spaceId, location),
        () => fallback.recordLocation(spaceId, location),
      ),
    recordLine: (spaceId, line) =>
      write(
        () => primary.recordLine(spaceId, line),
        () => fallback.recordLine(spaceId, line),
      ),
  };
}

/** True when mvp/sql/001_chat_context.sql has been applied. */
export async function hasChatContextTable(query: Query): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>("SELECT to_regclass('app.chat_context') IS NOT NULL AS exists");
  return rows[0]?.exists === true;
}

/** Same contract on Tiger (`app.chat_context`, see mvp/sql). Survives restarts and redeploys. */
export function createPgContextStore(query: Query): ContextStore {
  return {
    async get(spaceId) {
      const { rows } = await query<{
        last_lat: number | null;
        last_lng: number | null;
        last_label: string | null;
        fresh: boolean;
        recent: string[] | null;
      }>(
        `SELECT last_lat, last_lng, last_label, recent,
                location_at > now() - interval '6 hours' AS fresh
           FROM app.chat_context WHERE space_id = $1`,
        [spaceId],
      );
      const row = rows[0];
      if (!row) return { recent: [] };
      const lastLocation =
        row.fresh && row.last_lat != null && row.last_lng != null
          ? { label: row.last_label ?? "your shared location", latitude: row.last_lat, longitude: row.last_lng }
          : undefined;
      return { ...(lastLocation && { lastLocation }), recent: row.recent ?? [] };
    },
    async recordLocation(spaceId, location) {
      await query(
        `INSERT INTO app.chat_context (space_id, last_lat, last_lng, last_label, location_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (space_id) DO UPDATE
           SET last_lat = EXCLUDED.last_lat, last_lng = EXCLUDED.last_lng,
               last_label = EXCLUDED.last_label, location_at = now(), updated_at = now()`,
        [spaceId, location.latitude, location.longitude, location.label],
      );
    },
    async recordLine(spaceId, line) {
      await query(
        `INSERT INTO app.chat_context (space_id, recent) VALUES ($1, jsonb_build_array($2::text))
         ON CONFLICT (space_id) DO UPDATE
           SET recent = (
                 SELECT COALESCE(jsonb_agg(value ORDER BY ord), '[]'::jsonb)
                   FROM (SELECT value, ord
                           FROM jsonb_array_elements(app.chat_context.recent || jsonb_build_array($2::text))
                                WITH ORDINALITY AS t(value, ord)
                          ORDER BY ord DESC LIMIT ${MAX_LINES}) last_lines
               ),
               updated_at = now()`,
        [spaceId, line],
      );
    },
  };
}
