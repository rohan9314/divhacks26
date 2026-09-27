import type { Location } from "./contracts";

const NYC_CENTER = { latitude: 40.7549, longitude: -73.984 };

export type Geocoder = (query: string, signal?: AbortSignal) => Promise<Location | null>;

/**
 * Resolve a place name ("Columbia", "Jin Ramen") to coordinates with Google Places Text Search,
 * biased to NYC. Same key and API the food skill uses, so there is one geocoding source.
 */
export function createPlacesGeocoder(options: { apiKey: string; fetch?: typeof fetch }): Geocoder {
  const fetcher = options.fetch ?? fetch;
  return async (query, signal) => {
    const response = await fetcher("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": options.apiKey,
        "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
      },
      body: JSON.stringify({
        textQuery: /new york|nyc|manhattan|brooklyn|bronx|queens|staten/i.test(query)
          ? query
          : `${query}, New York, NY`,
        locationBias: { circle: { center: NYC_CENTER, radius: 30_000 } },
        pageSize: 1,
      }),
      signal: signal ?? AbortSignal.timeout(6_000),
    });
    if (!response.ok) throw new Error(`Places geocode returned ${response.status}`);
    const payload = (await response.json()) as {
      places?: Array<{
        displayName?: { text?: string };
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
      }>;
    };
    const place = payload.places?.[0];
    const latitude = place?.location?.latitude;
    const longitude = place?.location?.longitude;
    if (latitude == null || longitude == null) return null;
    return { label: place?.displayName?.text ?? place?.formattedAddress ?? query, latitude, longitude };
  };
}
