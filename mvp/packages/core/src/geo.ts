import type { Location, TravelMode } from "./contracts";

export function distanceMeters(
  a: Pick<Location, "latitude" | "longitude">,
  b: Pick<Location, "latitude" | "longitude">,
) {
  const radians = (value: number) => (value * Math.PI) / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(h));
}

export function mapsDirectionsUrl(origin: Location, destination: Location, mode: TravelMode): string {
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("origin", `${origin.latitude},${origin.longitude}`);
  url.searchParams.set("destination", `${destination.latitude},${destination.longitude}`);
  url.searchParams.set("travelmode", mode === "BICYCLE" ? "bicycling" : mode.toLowerCase());
  return url.toString();
}

const inNyc = (latitude: number, longitude: number) =>
  latitude > 40.4 && latitude < 41.0 && longitude > -74.3 && longitude < -73.6;

/**
 * Coordinates from a shared location. iMessage pins arrive as a small vCard with an
 * Apple Maps URL (maps.apple.com/?ll=40.807,-73.962); Google links use @lat,lng or q=lat,lng.
 * Only NYC coordinates are trusted; anything else is probably a parse mistake.
 */
export function parseLatLng(text: string): { latitude: number; longitude: number } | null {
  const patterns = [
    /[?&](?:ll|q|sll|daddr)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/,
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,
    /^\s*(-?\d{2}\.\d+)\s*,\s*(-?\d{2}\.\d+)\s*$/,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (!m) continue;
    const latitude = Number(m[1]);
    const longitude = Number(m[2]);
    if (inNyc(latitude, longitude)) return { latitude, longitude };
  }
  return null;
}
