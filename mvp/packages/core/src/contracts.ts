import { z } from "zod";
import type { Logger } from "./log";

export const SkillName = z.enum(["safety", "food", "events", "route"]);
export type SkillName = z.infer<typeof SkillName>;

export const TravelMode = z.enum(["WALK", "TRANSIT", "DRIVE", "BICYCLE"]);
export type TravelMode = z.infer<typeof TravelMode>;

export const Budget = z.enum(["free", "low", "medium", "high"]);
export type Budget = z.infer<typeof Budget>;

export const Location = z.object({
  label: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type Location = z.infer<typeof Location>;

export interface Source {
  name: string;
  url?: string;
  /** When the underlying data was last refreshed, if known. */
  updatedAt?: string;
}

export interface SkillResult<T> {
  status: "ok" | "partial" | "unavailable";
  data: T;
  sources: Source[];
  warnings: string[];
}

/** Anything the composer may recommend. `id` is the only handle Gemini is allowed to cite. */
export interface Recommendation {
  id: string;
  kind: "event" | "food";
  name: string;
  location: Location;
  distanceMeters: number;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  priceLevel?: string;
  rating?: number;
  openNow?: boolean;
  categories: string[];
  url?: string;
  source: Source;
}

export interface EventRecommendation extends Recommendation {
  kind: "event";
}

export interface FoodRecommendation extends Recommendation {
  kind: "food";
  placeId: string;
}

export interface RouteResult {
  id: string;
  mode: TravelMode;
  destinationLabel: string;
  durationMinutes?: number;
  distanceMeters?: number;
  summary: string;
  directionsUrl: string;
}

export interface SafetySummary {
  id: string;
  placeLabel: string;
  hourEt: number;
  radiusMeters: number;
  /** Complaints within the radius over the data window. */
  areaCount: number;
  /** Complaints within the radius at the requested hour. */
  hourCount: number;
  /** areaCount / 24: what an average hour looks like here. */
  typicalHourCount: number;
  peakHour: number | null;
  peakHourCount: number;
  topCategories: Array<{ offense: string; count: number }>;
  windowDays: number;
  dataThrough: string | null;
}

export interface SkillContext {
  now: Date;
  /** Aborted when the dispatcher's per-skill timeout fires. */
  signal: AbortSignal;
  log: Logger;
}

/**
 * The contract every skill implements. Skills get their credentials through their factory,
 * never from process.env, and never import the router or LangGraph.
 */
export interface Skill<I, O> {
  name: SkillName;
  /** The dispatcher parses raw input with this (defaults applied) before calling `run`. */
  input: z.ZodType<I, unknown>;
  timeoutMs: number;
  run(input: I, ctx: SkillContext): Promise<SkillResult<O>>;
}

export function unavailable<T>(data: T, warning: string): SkillResult<T> {
  return { status: "unavailable", data, sources: [], warnings: [warning] };
}

/** What Gemini extracts from a message. Locations are free text here; the router resolves them. */
export const UserIntent = z.object({
  needs: z
    .array(SkillName)
    .describe(
      "Only the skills this message asks for. safety = is it safe / crime around here. food = restaurants, eating, drinks. events = things to do, activities, fun. route = directions or how to get somewhere. Broad 'plan a night' requests need events, food and safety. Empty for greetings or small talk.",
    ),
  locationQuery: z
    .string()
    .optional()
    .describe(
      "A place the user names as where they are or want to be, e.g. 'Columbia' or 'Union Square'. Omit if none.",
    ),
  destinationQuery: z
    .string()
    .optional()
    .describe("For route requests: the place the user wants to get to. Omit if none."),
  when: z
    .string()
    .describe("When, in the user's words: 'now', 'tonight', 'tomorrow evening', 'at 9pm'. Default 'now'."),
  budget: Budget.optional(),
  categories: z.array(z.string()).describe("Activity categories in lowercase, e.g. 'music', 'outdoors', 'art'."),
  cuisine: z.array(z.string()).describe("Cuisines in lowercase, e.g. 'ramen', 'pizza'."),
  travelMode: TravelMode.describe("WALK unless the user says otherwise."),
});
export type UserIntent = z.infer<typeof UserIntent>;
