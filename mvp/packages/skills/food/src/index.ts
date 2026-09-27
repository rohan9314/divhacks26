import {
  Budget,
  distanceMeters,
  type FoodRecommendation,
  type Llm,
  Location,
  type Skill,
  type SkillResult,
  unavailable,
} from "@mvp/core";
import { z } from "zod";

export const FoodInput = z.object({
  origin: Location,
  cuisine: z.array(z.string()).default([]),
  budget: Budget.optional(),
  openNow: z.boolean().default(true),
  /** The user's own words, used only to rank candidates Places already returned. */
  request: z.string().max(500).default(""),
});
export type FoodInput = z.infer<typeof FoodInput>;

interface PlacesResponse {
  places?: Array<{
    id?: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
    priceLevel?: string;
    rating?: number;
    currentOpeningHours?: { openNow?: boolean };
    googleMapsUri?: string;
    primaryTypeDisplayName?: { text?: string };
  }>;
}

const PRICE_LEVELS: Partial<Record<z.infer<typeof Budget>, string[]>> = {
  free: ["PRICE_LEVEL_INEXPENSIVE"],
  low: ["PRICE_LEVEL_INEXPENSIVE"],
  medium: ["PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE"],
  high: ["PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"],
};

const Ranking = z.object({
  orderedIds: z.array(z.string()).describe("Candidate ids, best fit first. Only ids from the list."),
});

/** Deterministic order used when Gemini is unavailable: open, then rating, then distance. */
function byDefault(a: FoodRecommendation, b: FoodRecommendation) {
  return (
    Number(b.openNow ?? false) - Number(a.openNow ?? false) ||
    (b.rating ?? 0) - (a.rating ?? 0) ||
    a.distanceMeters - b.distanceMeters
  );
}

/**
 * Keith owns this skill. Google Places supplies every fact; Gemini may only reorder the place ids
 * it was given. Anything else it returns is ignored.
 */
export function createFoodSkill(deps: {
  apiKey?: string;
  llm?: Llm;
  fetch?: typeof fetch;
}): Skill<FoodInput, FoodRecommendation[]> {
  const fetcher = deps.fetch ?? fetch;
  return {
    name: "food",
    input: FoodInput,
    timeoutMs: 10_000,
    async run(input, ctx): Promise<SkillResult<FoodRecommendation[]>> {
      if (!deps.apiKey) return unavailable([], "Restaurant search is not configured.");
      const cuisine = input.cuisine.length ? `${input.cuisine.join(" or ")} ` : "";
      const body: Record<string, unknown> = {
        textQuery: `${cuisine}restaurants near ${input.origin.label}, New York City`,
        locationBias: {
          circle: { center: { latitude: input.origin.latitude, longitude: input.origin.longitude }, radius: 2_000 },
        },
        includedType: "restaurant",
        openNow: input.openNow,
        pageSize: 10,
      };
      const priceLevels = input.budget && PRICE_LEVELS[input.budget];
      if (priceLevels) body.priceLevels = priceLevels;

      let candidates: FoodRecommendation[];
      try {
        const response = await fetcher("https://places.googleapis.com/v1/places:searchText", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": deps.apiKey,
            "X-Goog-FieldMask": [
              "places.id",
              "places.displayName",
              "places.formattedAddress",
              "places.location",
              "places.priceLevel",
              "places.rating",
              "places.currentOpeningHours.openNow",
              "places.googleMapsUri",
              "places.primaryTypeDisplayName",
            ].join(","),
          },
          body: JSON.stringify(body),
          signal: ctx.signal,
        });
        if (!response.ok) throw new Error(`Places API returned ${response.status}`);
        const payload = (await response.json()) as PlacesResponse;
        candidates = (payload.places ?? []).flatMap((place): FoodRecommendation[] => {
          const latitude = place.location?.latitude;
          const longitude = place.location?.longitude;
          const name = place.displayName?.text;
          if (!place.id || !name || latitude == null || longitude == null) return [];
          const location = { label: place.formattedAddress ?? name, latitude, longitude };
          const mapsUrl =
            place.googleMapsUri ??
            `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${place.id}`;
          return [
            {
              id: `food:${place.id}`,
              kind: "food",
              placeId: place.id,
              name,
              location,
              distanceMeters: Math.round(distanceMeters(input.origin, location)),
              ...(place.priceLevel && { priceLevel: place.priceLevel }),
              ...(place.rating != null && { rating: place.rating }),
              ...(place.currentOpeningHours?.openNow != null && { openNow: place.currentOpeningHours.openNow }),
              categories: [place.primaryTypeDisplayName?.text ?? "restaurant"],
              url: mapsUrl,
              source: { name: "Google Places", url: mapsUrl },
            },
          ];
        });
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        ctx.log.warn({ skill: "food", err: (error as Error).message }, "places request failed");
        return unavailable([], "Restaurant search is temporarily unavailable.");
      }

      if (!candidates.length) {
        return {
          status: "partial",
          data: [],
          sources: [{ name: "Google Places" }],
          warnings: ["No matching restaurants were found nearby."],
        };
      }

      const ranked = await rank(candidates.sort(byDefault), input, deps.llm, ctx.log);
      return { status: "ok", data: ranked.slice(0, 5), sources: [{ name: "Google Places" }], warnings: [] };
    },
  };
}

async function rank(
  candidates: FoodRecommendation[],
  input: FoodInput,
  llm: Llm | undefined,
  log: { warn: (obj: object, msg: string) => void },
): Promise<FoodRecommendation[]> {
  if (!llm || candidates.length < 2 || (!input.request && !input.cuisine.length && !input.budget)) return candidates;
  try {
    const { orderedIds } = await llm.json({
      task: "rankFood",
      system:
        "Rank restaurant candidates for a group in NYC. Use only the candidate data given. Return candidate ids only.",
      prompt: JSON.stringify({
        request: input.request,
        cuisine: input.cuisine,
        budget: input.budget ?? null,
        candidates: candidates.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.categories[0],
          priceLevel: c.priceLevel ?? null,
          rating: c.rating ?? null,
          openNow: c.openNow ?? null,
          distanceMeters: c.distanceMeters,
        })),
      }),
      schema: Ranking,
      timeoutMs: 5_000,
    });
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const picked = [...new Set(orderedIds)].flatMap((id) => byId.get(id) ?? []);
    return [...picked, ...candidates.filter((c) => !picked.includes(c))];
  } catch (error) {
    log.warn({ skill: "food", err: (error as Error).message }, "gemini ranking failed; using default order");
    return candidates;
  }
}
