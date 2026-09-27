import type {
  EventRecommendation,
  FoodRecommendation,
  Location,
  RouteResult,
  SafetySummary,
  Skill,
  SkillName,
  SkillResult,
} from "@mvp/core";
import { silentLogger } from "@mvp/core";
import { z } from "zod";
import type { SkillRegistry } from "../src";

export const COLUMBIA: Location = { label: "Columbia University", latitude: 40.8075, longitude: -73.9626 };

export const EVENT: EventRecommendation = {
  id: "event:parks:1",
  kind: "event",
  name: "Outdoor Movie Night",
  location: { label: "Riverside Park", latitude: 40.8013, longitude: -73.9713 },
  distanceMeters: 1000,
  startsAt: "2026-09-26T23:30:00.000Z",
  categories: ["film"],
  url: "https://www.nycgovparks.org/events/1",
  source: { name: "NYC Parks", url: "https://www.nycgovparks.org/events/1" },
};

export const FOOD: FoodRecommendation = {
  id: "food:abc",
  kind: "food",
  placeId: "abc",
  name: "Jin Ramen",
  location: { label: "3183 Broadway", latitude: 40.8149, longitude: -73.9587 },
  distanceMeters: 900,
  priceLevel: "PRICE_LEVEL_MODERATE",
  rating: 4.5,
  openNow: true,
  categories: ["Ramen restaurant"],
  url: "https://maps.google.com/?cid=1",
  source: { name: "Google Places", url: "https://maps.google.com/?cid=1" },
};

export const SAFETY: SafetySummary = {
  id: "safety:40.808,-73.963",
  placeLabel: "Columbia University",
  hourEt: 19,
  radiusMeters: 800,
  areaCount: 2400,
  hourCount: 80,
  typicalHourCount: 100,
  peakHour: 16,
  peakHourCount: 160,
  topCategories: [{ offense: "PETIT LARCENY", count: 600 }],
  windowDays: 700,
  dataThrough: "2026-06-30",
};

export const ROUTE: RouteResult = {
  id: "route:Riverside Park",
  mode: "WALK",
  destinationLabel: "Riverside Park",
  durationMinutes: 12,
  distanceMeters: 1000,
  summary: "12 min walk to Riverside Park",
  directionsUrl: "https://www.google.com/maps/dir/?api=1&destination=40.8013,-73.9713",
};

type Behavior<T> = "ok" | "throw" | "hang" | ((input: unknown) => SkillResult<T>);

export interface FakeSkills {
  registry: SkillRegistry;
  calls: Record<SkillName, unknown[]>;
}

function fake<T>(
  name: SkillName,
  data: T,
  behavior: Behavior<T>,
  timeoutMs = 200,
): Skill<unknown, T> & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    name,
    input: z.any(),
    timeoutMs,
    calls,
    async run(input) {
      calls.push(input);
      if (behavior === "throw") throw new Error(`${name} exploded`);
      if (behavior === "hang") return new Promise<never>(() => {});
      if (typeof behavior === "function") return behavior(input);
      return { status: "ok", data, sources: [{ name }], warnings: [] };
    },
  };
}

export function fakeSkills(
  behaviors: Partial<{
    safety: Behavior<SafetySummary | null>;
    events: Behavior<EventRecommendation[]>;
    food: Behavior<FoodRecommendation[]>;
    route: Behavior<RouteResult>;
  }> = {},
): FakeSkills {
  const safety = fake("safety", SAFETY as SafetySummary | null, behaviors.safety ?? "ok");
  const events = fake("events", [EVENT], behaviors.events ?? "ok");
  const food = fake("food", [FOOD], behaviors.food ?? "ok");
  const route = fake("route", ROUTE, behaviors.route ?? "ok");
  return {
    registry: { safety, events, food, route },
    calls: { safety: safety.calls, events: events.calls, food: food.calls, route: route.calls },
  };
}

export const deps = (skills: FakeSkills, extra: Record<string, unknown> = {}) => ({
  skills: skills.registry,
  log: silentLogger,
  geocode: async (q: string) => (/columbia/i.test(q) ? COLUMBIA : /jin ramen/i.test(q) ? FOOD.location : null),
  ...extra,
});

export const NOW = new Date("2026-09-26T23:00:00Z"); // Sat 7 PM in New York
