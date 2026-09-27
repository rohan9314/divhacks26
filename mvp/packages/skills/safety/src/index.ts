import { Location, type Query, type SafetySummary, type Skill, type SkillResult, unavailable } from "@mvp/core";
import { z } from "zod";

export const SafetyInput = z.object({
  origin: Location,
  hourEt: z.number().int().min(0).max(23),
});
export type SafetyInput = z.infer<typeof SafetyInput>;

const RADIUS_METERS = 800;
const SOURCE = { name: "NYPD Complaint Data via Tiger", url: "https://data.cityofnewyork.us/d/5uac-w243" };

// Historical complaints within RADIUS of the point over the last two years, bucketed by NYC hour.
// The bounding box keeps the lat/lon index useful before the exact distance filter.
const SQL = `
WITH pt AS (SELECT $1::float8 AS lat, $2::float8 AS lon),
nearby AS (
  SELECT
    COALESCE(c.offense, '(unspecified)') AS offense,
    extract(hour from c.occurred_at AT TIME ZONE 'America/New_York')::int AS hour_et,
    c.occurred_at
  FROM nypd_complaints c CROSS JOIN pt
  WHERE c.occurred_at >= now() - interval '2 years'
    AND c.latitude BETWEEN pt.lat - 0.009 AND pt.lat + 0.009
    AND c.longitude BETWEEN pt.lon - 0.012 AND pt.lon + 0.012
    AND 6371000 * 2 * asin(sqrt(
          power(sin(radians(c.latitude - pt.lat) / 2), 2)
          + cos(radians(pt.lat)) * cos(radians(c.latitude)) * power(sin(radians(c.longitude - pt.lon) / 2), 2)
        )) < $3
)
SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM nearby),
  'byHour', COALESCE((SELECT jsonb_object_agg(hour_et, n) FROM (SELECT hour_et, count(*)::int AS n FROM nearby GROUP BY 1) h), '{}'::jsonb),
  'top', COALESCE((SELECT jsonb_agg(jsonb_build_object('offense', offense, 'count', n) ORDER BY n DESC)
                   FROM (SELECT offense, count(*)::int AS n FROM nearby GROUP BY 1 ORDER BY n DESC LIMIT 3) t), '[]'::jsonb),
  'first', (SELECT min(occurred_at) FROM nearby),
  'last', (SELECT max(occurred_at) FROM nearby)
) AS report
`;

interface Row extends Record<string, unknown> {
  report: {
    total: number | string;
    byHour: Record<string, number>;
    top: Array<{ offense: string; count: number }>;
    first: string | null;
    last: string | null;
  };
}

/** Alan owns this skill. Counts and comparisons only: never a safe/unsafe verdict. */
export function createSafetySkill(deps: { query?: Query }): Skill<SafetyInput, SafetySummary | null> {
  return {
    name: "safety",
    input: SafetyInput,
    timeoutMs: 8_000,
    async run(input, ctx): Promise<SkillResult<SafetySummary | null>> {
      if (!deps.query) return unavailable(null, "Historical safety data is not configured.");
      try {
        const { rows } = await deps.query<Row>(SQL, [input.origin.latitude, input.origin.longitude, RADIUS_METERS]);
        const report = rows[0]?.report;
        const areaCount = Number(report?.total ?? 0);
        if (!report || areaCount === 0) {
          return {
            status: "partial",
            data: null,
            sources: [SOURCE],
            warnings: ["No historical NYPD complaints were found near this point."],
          };
        }
        let peakHour: number | null = null;
        let peakHourCount = 0;
        for (const [hour, count] of Object.entries(report.byHour)) {
          if (count > peakHourCount) {
            peakHour = Number(hour);
            peakHourCount = count;
          }
        }
        const days =
          report.first && report.last
            ? Math.max(1, Math.round((Date.parse(report.last) - Date.parse(report.first)) / 86_400_000))
            : 0;
        return {
          status: "ok",
          data: {
            id: `safety:${input.origin.latitude.toFixed(3)},${input.origin.longitude.toFixed(3)}`,
            placeLabel: input.origin.label,
            hourEt: input.hourEt,
            radiusMeters: RADIUS_METERS,
            areaCount,
            hourCount: report.byHour[String(input.hourEt)] ?? 0,
            typicalHourCount: Math.round((areaCount / 24) * 10) / 10,
            peakHour,
            peakHourCount,
            topCategories: report.top,
            windowDays: days,
            dataThrough: report.last ? new Date(report.last).toISOString().slice(0, 10) : null,
          },
          sources: [{ ...SOURCE, ...(report.last && { updatedAt: new Date(report.last).toISOString() }) }],
          warnings: ["Historical reports, not live conditions."],
        };
      } catch (error) {
        ctx.log.warn({ skill: "safety", err: (error as Error).message }, "safety query failed");
        return unavailable(null, "Historical safety data is temporarily unavailable.");
      }
    },
  };
}
