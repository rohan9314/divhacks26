import { Location, mapsDirectionsUrl, type RouteResult, type Skill, type SkillResult, TravelMode } from "@mvp/core";
import { z } from "zod";

export const RouteInput = z.object({
  origin: Location,
  destination: Location,
  travelMode: TravelMode,
  departureTime: z.string().optional(),
});
export type RouteInput = z.infer<typeof RouteInput>;

interface RoutesResponse {
  routes?: Array<{ duration?: string; distanceMeters?: number }>;
}

const minutesFrom = (duration?: string) => {
  const seconds = Number(duration?.replace(/s$/, ""));
  return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : undefined;
};

/**
 * Rohan owns this skill. Google Routes API for a real duration. If Routes fails, it still returns
 * a working Maps link, marked partial, and never claims a duration it didn't get.
 */
export function createRouteSkill(deps: { apiKey?: string; fetch?: typeof fetch }): Skill<RouteInput, RouteResult> {
  const fetcher = deps.fetch ?? fetch;
  return {
    name: "route",
    input: RouteInput,
    timeoutMs: 8_000,
    async run(input, ctx): Promise<SkillResult<RouteResult>> {
      const directionsUrl = mapsDirectionsUrl(input.origin, input.destination, input.travelMode);
      const linkOnly: RouteResult = {
        id: `route:${input.destination.label}`,
        mode: input.travelMode,
        destinationLabel: input.destination.label,
        summary: `Directions to ${input.destination.label}`,
        directionsUrl,
      };
      const partial = (warning: string): SkillResult<RouteResult> => ({
        status: "partial",
        data: linkOnly,
        sources: [{ name: "Google Maps", url: directionsUrl }],
        warnings: [warning],
      });
      if (!deps.apiKey) return partial("Travel time is unavailable (routing is not configured).");

      const body: Record<string, unknown> = {
        origin: { location: { latLng: { latitude: input.origin.latitude, longitude: input.origin.longitude } } },
        destination: {
          location: { latLng: { latitude: input.destination.latitude, longitude: input.destination.longitude } },
        },
        travelMode: input.travelMode,
        languageCode: "en-US",
        units: "IMPERIAL",
      };
      if (input.departureTime && input.travelMode === "TRANSIT") body.departureTime = input.departureTime;
      if (input.travelMode === "DRIVE") body.routingPreference = "TRAFFIC_AWARE";

      try {
        const response = await fetcher("https://routes.googleapis.com/directions/v2:computeRoutes", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": deps.apiKey,
            "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
          },
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        if (!response.ok) throw new Error(`Routes API returned ${response.status}`);
        const route = ((await response.json()) as RoutesResponse).routes?.[0];
        const durationMinutes = minutesFrom(route?.duration);
        if (!route || durationMinutes == null) return partial("Travel time is unavailable for this route.");
        const mode = input.travelMode.toLowerCase();
        return {
          status: "ok",
          data: {
            ...linkOnly,
            durationMinutes,
            distanceMeters: route.distanceMeters,
            summary: `${durationMinutes} min ${mode} to ${input.destination.label}`,
          },
          sources: [{ name: "Google Routes", url: directionsUrl }],
          warnings: [],
        };
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        ctx.log.warn({ skill: "route", err: (error as Error).message }, "routes request failed");
        return partial("Travel time is temporarily unavailable.");
      }
    },
  };
}
