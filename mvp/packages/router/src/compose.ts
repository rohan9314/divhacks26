import { formatHour, type Llm, type Location, type Recommendation, type SkillName } from "@mvp/core";
import { z } from "zod";
import type { Results } from "./dispatch";

const MAX_PICKS = 3;

export interface Draft {
  text: string;
  citedIds: string[];
  source: "gemini" | "template";
  /** Why the Gemini draft was rejected, when it was. */
  rejected?: string;
}

const ComposerOutput = z.object({
  text: z.string().min(1).max(900).describe("The reply body. No URLs. No markdown."),
  citedIds: z.array(z.string()).describe("Ids of every recommendation mentioned in text, in the order mentioned."),
});

const SYSTEM = [
  "You write one short iMessage reply for friends in NYC.",
  "Use ONLY the facts in the JSON you are given. Never add a place, event, time, price, rating, duration or statistic that is not in it.",
  "Mention at most 3 recommendations, each with one short reason it fits now. Put each in citedIds.",
  "Do not include URLs; links are added after your text.",
  "Safety data is historical NYPD complaint counts: state it as a short neutral note (a count and a comparison), never as safe/unsafe, and never as the headline unless the user asked about safety.",
  "If a part is listed under unavailable, do not guess it.",
  "Plain text, no markdown, under 600 characters.",
].join(" ");

/** Every recommendation the skills returned, keyed by id. The only things the reply may cite. */
export function recommendationsById(results: Results): Map<string, Recommendation> {
  const all = [...(results.events?.data ?? []), ...(results.food?.data ?? [])];
  return new Map(all.map((r) => [r.id, r]));
}

function picks(results: Results): Recommendation[] {
  return [...(results.events?.data ?? []).slice(0, 2), ...(results.food?.data ?? []).slice(0, 2)].slice(0, MAX_PICKS);
}

export function unavailableSkills(needs: SkillName[], results: Results): SkillName[] {
  return needs.filter((name) => results[name]?.status === "unavailable" || (name !== "route" && !results[name]));
}

const miles = (meters: number) => `${(meters / 1609.34).toFixed(1)} mi`;

const clock = (iso: string, withDay: boolean) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    ...(withDay && { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

/** "Mon 6:45 PM", or "on now until 7:00 PM" for an event already underway. */
export function eventTime(event: { startsAt?: string; endsAt?: string }, now: Date): string | undefined {
  if (!event.startsAt) return undefined;
  if (Date.parse(event.startsAt) <= now.getTime()) {
    return event.endsAt ? `on now until ${clock(event.endsAt, false)}` : "on now";
  }
  return clock(event.startsAt, true);
}

const PRICE: Record<string, string> = {
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

/** Computed here, not by the model, so the comparison can't be flipped. */
export function compareHour(hourCount: number, typical: number): "lower" | "higher" | "about the same" {
  if (typical <= 0) return "about the same";
  const ratio = hourCount / typical;
  return ratio < 0.85 ? "lower" : ratio > 1.15 ? "higher" : "about the same";
}

/** The facts Gemini sees: compact, id-tagged, nothing it could mistake for permission to invent. */
export function factsFor(input: { text: string; origin: Location; needs: SkillName[]; results: Results; now: Date }) {
  const { results } = input;
  const safety = results.safety?.data;
  const route = results.route?.data;
  return {
    userMessage: input.text,
    near: input.origin.label,
    events: (results.events?.data ?? []).slice(0, 3).map((e) => ({
      id: e.id,
      name: e.name,
      venue: e.location.label,
      when: eventTime(e, input.now),
      distance: miles(e.distanceMeters),
      category: e.categories[0],
    })),
    restaurants: (results.food?.data ?? []).slice(0, 3).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.categories[0],
      price: f.priceLevel ? PRICE[f.priceLevel] : undefined,
      rating: f.rating,
      openNow: f.openNow,
      distance: miles(f.distanceMeters),
    })),
    safety: safety
      ? {
          note: "historical NYPD complaint reports, not live conditions",
          hour: formatHour(safety.hourEt),
          reportsAtThisHour: safety.hourCount,
          averageReportsPerHourAcrossAllHours: safety.typicalHourCount,
          thisHourComparedWithAnAverageHour: compareHour(safety.hourCount, safety.typicalHourCount),
          busiestHour: safety.peakHour == null ? undefined : formatHour(safety.peakHour),
          mostCommon: safety.topCategories.map((c) => c.offense.toLowerCase()),
          radiusMeters: safety.radiusMeters,
          overDays: safety.windowDays,
        }
      : undefined,
    route: route?.durationMinutes
      ? { to: route.destinationLabel, minutes: route.durationMinutes, mode: route.mode.toLowerCase() }
      : undefined,
    unavailable: unavailableSkills(input.needs, results),
  };
}

export async function composeWithGemini(
  llm: Llm,
  facts: ReturnType<typeof factsFor>,
): Promise<{ text: string; citedIds: string[] }> {
  return llm.json({
    task: "composeReply",
    system: SYSTEM,
    prompt: JSON.stringify(facts),
    schema: ComposerOutput,
    timeoutMs: 10_000,
  });
}

/**
 * Reject a Gemini draft that cites anything the skills didn't return, carries its own links,
 * or states a travel time other than the one Routes gave.
 */
export function checkDraft(
  draft: { text: string; citedIds: string[] },
  results: Results,
): { ok: true } | { ok: false; reason: string } {
  const known = recommendationsById(results);
  const unknown = draft.citedIds.filter((id) => !known.has(id));
  if (unknown.length) return { ok: false, reason: `cited unknown ids: ${unknown.join(", ")}` };
  if (/https?:\/\/|www\.|\.com\b/i.test(draft.text)) return { ok: false, reason: "contained a link" };
  if (known.size && !draft.citedIds.length) return { ok: false, reason: "cited nothing" };
  for (const id of draft.citedIds) {
    // Match the main part of the name: "Harlem Run: Monday Night Run" may be written "Harlem Run".
    const name = known
      .get(id)
      ?.name.split(/[:(\u2013\u2014]/)[0]
      ?.trim();
    if (name && !draft.text.toLowerCase().includes(name.toLowerCase().slice(0, 12))) {
      return { ok: false, reason: `cited ${id} without naming it` };
    }
  }
  const allowedMinutes = new Set<number>();
  const minutes = results.route?.data?.durationMinutes;
  if (minutes) allowedMinutes.add(minutes);
  for (const match of draft.text.matchAll(/(\d+)\s*(?:-|\s)?(?:min|minute)/gi)) {
    if (!allowedMinutes.has(Number(match[1]))) return { ok: false, reason: `stated ${match[1]} min not from Routes` };
  }
  return { ok: true };
}

function safetyLine(results: Results): string | undefined {
  const s = results.safety?.data;
  if (!s) return undefined;
  const through = s.dataThrough ? ` (NYPD data through ${s.dataThrough})` : "";
  const peak = s.peakHour == null ? "" : `; the busiest hour is ${formatHour(s.peakHour)}`;
  const comparison = compareHour(s.hourCount, s.typicalHourCount);
  return `Historical reports within ${s.radiusMeters} m at ${formatHour(s.hourEt)} are ${comparison === "about the same" ? "about the same as" : `${comparison} than`} an average hour here (${s.hourCount} vs ${s.typicalHourCount} over ${s.windowDays} days${peak})${through}. Not a live safety rating.`;
}

/** The reply without Gemini: built only from skill data, so it is grounded by construction. */
export function templateDraft(input: { origin: Location; needs: SkillName[]; results: Results; now: Date }): Draft {
  const lines: string[] = [];
  const chosen = picks(input.results);
  if (chosen.length) {
    lines.push(`Near ${input.origin.label}:`);
    chosen.forEach((r, i) => {
      const details =
        r.kind === "event"
          ? [eventTime(r, input.now), miles(r.distanceMeters)]
          : [
              r.openNow ? "open now" : undefined,
              r.priceLevel ? PRICE[r.priceLevel] : undefined,
              r.rating ? `${r.rating}★` : undefined,
              miles(r.distanceMeters),
            ];
      lines.push(`${i + 1}. ${r.name} — ${details.filter(Boolean).join(", ")}`);
    });
  }
  const safety = safetyLine(input.results);
  if (safety) lines.push(input.needs.length === 1 ? safety : `\n${safety}`);
  if (!lines.length) {
    // Empty-but-working results explain themselves ("No official NYC events matched…");
    // unavailable skills are disclosed by finalize(), so their warnings aren't repeated here.
    const warnings = Object.values(input.results)
      .filter((r) => r && r.status !== "unavailable")
      .flatMap((r) => r?.warnings ?? []);
    lines.push(warnings[0] ?? "I couldn't find anything for that nearby right now.");
  }
  return { text: lines.join("\n"), citedIds: chosen.map((r) => r.id), source: "template" };
}

const LABEL: Record<SkillName, string> = {
  safety: "historical safety data",
  events: "event listings",
  food: "restaurant search",
  route: "travel times",
};

/** Links, route and disclosures are added in code so the model can't get them wrong. */
export function finalize(draft: Draft, input: { needs: SkillName[]; results: Results }): string {
  const known = recommendationsById(input.results);
  const out = [draft.text.trim()];
  const links = draft.citedIds.flatMap((id) => {
    const r = known.get(id);
    return r?.url ? [`${r.name}: ${r.url}`] : [];
  });
  if (links.length) out.push(links.join("\n"));
  const route = input.results.route?.data;
  if (route) {
    out.push(
      route.durationMinutes
        ? `Route: ${route.durationMinutes} min ${route.mode.toLowerCase()} to ${route.destinationLabel} → ${route.directionsUrl}`
        : `Directions to ${route.destinationLabel}: ${route.directionsUrl}`,
    );
  }
  // A search that worked but found nothing says so, so silence is never mistaken for "nothing exists".
  const empty = (["events", "food"] as const).filter(
    (name) =>
      input.needs.includes(name) && input.results[name]?.status === "partial" && !input.results[name]?.data.length,
  );
  const emptyNotes = empty.flatMap((name) => input.results[name]?.warnings.slice(0, 1) ?? []);
  if (emptyNotes.length && !emptyNotes.every((note) => draft.text.includes(note))) out.push(emptyNotes.join(" "));
  const missing = unavailableSkills(input.needs, input.results);
  if (missing.length) out.push(`(Couldn't reach ${missing.map((m) => LABEL[m]).join(" or ")} right now.)`);
  return out.join("\n\n");
}
