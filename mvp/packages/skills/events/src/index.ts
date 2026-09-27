import {
  Budget,
  type EventRecommendation,
  Location,
  type Query,
  type Skill,
  type SkillResult,
  type Source,
  unavailable,
} from "@mvp/core";
import { z } from "zod";

export const EventsInput = z.object({
  origin: Location,
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  radiusMeters: z.number().min(250).max(20_000).default(2_000),
  categories: z.array(z.string()).default([]),
  budget: Budget.optional(),
});
export type EventsInput = z.infer<typeof EventsInput>;

const SOURCES: Source[] = [
  { name: "NYC Parks Upcoming Events", url: "https://data.cityofnewyork.us/d/w3wp-dpdi" },
  { name: "NYC Permitted Event Information", url: "https://data.cityofnewyork.us/d/tvpp-9vvx" },
];

// Official events in the window, inside the radius, optionally filtered by category.
// Ordered by start time, then distance, then freshest ingest.
const SQL = `
WITH o AS (SELECT $1::float8 AS lat, $2::float8 AS lon),
nearby AS (
  SELECT e.*,
    6371000 * 2 * asin(sqrt(
      power(sin(radians(e.latitude - o.lat) / 2), 2)
      + cos(radians(o.lat)) * cos(radians(e.latitude)) * power(sin(radians(e.longitude - o.lon) / 2), 2)
    )) AS distance_meters
  FROM city_events e CROSS JOIN o
  WHERE e.latitude IS NOT NULL AND e.longitude IS NOT NULL
    AND e.starts_at <= $4::timestamptz
    AND COALESCE(e.ends_at, e.starts_at) >= $3::timestamptz
    AND e.latitude BETWEEN o.lat - ($5::float8 / 111000.0) AND o.lat + ($5::float8 / 111000.0)
    AND e.longitude BETWEEN o.lon - ($5::float8 / 85000.0) AND o.lon + ($5::float8 / 85000.0)
    AND (
      cardinality($6::text[]) = 0
      OR EXISTS (SELECT 1 FROM unnest($6::text[]) c WHERE lower(COALESCE(e.category, '') || ' ' || e.title) LIKE '%' || lower(c) || '%')
    )
)
SELECT * FROM nearby
WHERE distance_meters <= $5
ORDER BY starts_at ASC, distance_meters ASC, updated_at DESC
LIMIT 20
`;

interface EventRow extends Record<string, unknown> {
  source: string;
  source_id: string;
  title: string;
  description: string | null;
  category: string | null;
  starts_at: Date | string;
  ends_at: Date | string | null;
  venue: string | null;
  latitude: number | string;
  longitude: number | string;
  source_url: string | null;
  registration_url: string | null;
  updated_at: Date | string;
  distance_meters: number | string;
}

const ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };

/** The Parks feed carries HTML entities ("Espa&#241;ol"); iMessage shows them literally. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const point = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(point) ? String.fromCodePoint(point) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

export function toRecommendation(row: EventRow): EventRecommendation {
  const venue = row.venue ? decodeEntities(row.venue) : undefined;
  const name = decodeEntities(row.title);
  return {
    id: `event:${row.source}:${row.source_id}`,
    kind: "event",
    name,
    location: { label: venue || name, latitude: Number(row.latitude), longitude: Number(row.longitude) },
    distanceMeters: Math.round(Number(row.distance_meters)),
    ...(row.description && { description: decodeEntities(row.description).slice(0, 280) }),
    startsAt: new Date(row.starts_at).toISOString(),
    ...(row.ends_at && { endsAt: new Date(row.ends_at).toISOString() }),
    categories: row.category ? [row.category] : [],
    ...((row.registration_url || row.source_url) && { url: (row.registration_url || row.source_url) as string }),
    source: {
      name: row.source,
      ...(row.source_url && { url: row.source_url }),
      updatedAt: new Date(row.updated_at).toISOString(),
    },
  };
}

/** The same event often appears in both official feeds; keep the first (freshest-ordered) copy. */
export function dedupe(events: EventRecommendation[]): EventRecommendation[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    const key = [
      event.name.toLowerCase().replace(/\W+/g, " ").trim(),
      event.startsAt?.slice(0, 16),
      event.location.latitude.toFixed(3),
      event.location.longitude.toFixed(3),
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Parks events cluster by day; if nothing is close, look once more a little further out. */
const WIDER_RADIUS_METERS = 5_000;

/** Events owner's skill. Official NYC datasets in Tiger are the source of truth. */
export function createEventsSkill(deps: { query?: Query }): Skill<EventsInput, EventRecommendation[]> {
  return {
    name: "events",
    input: EventsInput,
    timeoutMs: 8_000,
    async run(input, ctx): Promise<SkillResult<EventRecommendation[]>> {
      const query = deps.query;
      if (!query) return unavailable([], "Event data is not configured.");
      const search = (radius: number) =>
        query<EventRow>(SQL, [
          input.origin.latitude,
          input.origin.longitude,
          input.from,
          input.to,
          radius,
          input.categories,
        ]);
      try {
        let { rows } = await search(input.radiusMeters);
        if (!rows.length && input.radiusMeters < WIDER_RADIUS_METERS) ({ rows } = await search(WIDER_RADIUS_METERS));
        const events = dedupe(rows.map(toRecommendation)).slice(0, 5);
        return {
          status: events.length ? "ok" : "partial",
          data: events,
          sources: SOURCES,
          warnings: events.length ? [] : ["No official NYC events matched this time and place."],
        };
      } catch (error) {
        ctx.log.warn({ skill: "events", err: (error as Error).message }, "events query failed");
        return unavailable([], "Event search is temporarily unavailable.");
      }
    },
  };
}
