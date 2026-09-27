import { type Llm, type SkillName, type TravelMode, UserIntent } from "@mvp/core";

const SYSTEM = [
  "You turn one iMessage into a structured request for an NYC 'around me' assistant.",
  "Pick only the skills the message asks for. Focused questions get one skill.",
  "'Plan a night', 'what should we do' and similar broad asks need events, food and safety.",
  "Greetings, thanks and small talk need no skills.",
  "Never invent places. Copy place names exactly as the user wrote them.",
].join(" ");

export async function parseIntent(
  text: string,
  recent: string[],
  llm: Llm | undefined,
): Promise<{ intent: UserIntent; source: "gemini" | "heuristic" }> {
  if (llm) {
    try {
      const intent = await llm.json({
        task: "parseIntent",
        system: SYSTEM,
        prompt: [recent.length ? `Recent messages:\n${recent.slice(-6).join("\n")}\n` : "", `Message: ${text}`].join(
          "\n",
        ),
        schema: UserIntent,
        timeoutMs: 8_000,
      });
      return { intent: { ...intent, needs: [...new Set(intent.needs)] }, source: "gemini" };
    } catch {
      // Fall through: a keyword parse still lets focused questions work without Gemini.
    }
  }
  return { intent: heuristicIntent(text), source: "heuristic" };
}

/** Keyword fallback. Deliberately simple; Gemini is the real parser. */
export function heuristicIntent(text: string): UserIntent {
  const destination = text.match(/\b(?:get to|directions to|walk to|way to)\s+(.+?)[?.!]*$/i)?.[1]?.trim();
  // A destination's name ("Jin Ramen") is not a request for that category.
  const t = (destination ? text.replace(destination, "") : text).toLowerCase();
  const needs = new Set<SkillName>();
  if (/\b(plan|night out|what should (we|i) do|date night)\b/.test(t)) {
    needs.add("events").add("food").add("safety");
  }
  if (/\b(safe|safety|crime|dangerous|sketchy)\b/.test(t)) needs.add("safety");
  if (/\b(eat|food|dinner|lunch|breakfast|brunch|restaurants?|hungry|ramen|pizza|sushi|tacos?|coffee)\b/.test(t)) {
    needs.add("food");
  }
  if (/\b(events?|fun|things to do|activit(y|ies)|concerts?|shows?|festivals?|music)\b/.test(t)) needs.add("events");
  if (/\b(how (do|can|should) (i|we) get|directions|route|get to|walk to|way to)\b/.test(t)) needs.add("route");

  const travelMode: TravelMode = /\b(transit|subway|train|bus)\b/.test(t)
    ? "TRANSIT"
    : /\b(drive|driving|car|uber|taxi)\b/.test(t)
      ? "DRIVE"
      : /\b(bike|cycling|citi ?bike)\b/.test(t)
        ? "BICYCLE"
        : "WALK";

  const near = text.match(/\b(?:near|around|by)\s+([A-Z][\w'.&-]*(?:\s+[A-Z][\w'.&-]*)*)/)?.[1]?.trim();
  const when = t.match(
    /\b(tonight|tomorrow(?: (?:morning|afternoon|evening|night))?|this weekend|at \d{1,2}(?::\d{2})?\s*(?:am|pm))\b/,
  )?.[1];

  return {
    needs: [...needs],
    ...(near && { locationQuery: near }),
    ...(destination && { destinationQuery: destination }),
    when: when ?? "now",
    categories: [],
    cuisine: [...t.matchAll(/\b(ramen|pizza|sushi|tacos?|thai|indian|chinese|italian|mexican|korean|burgers?)\b/g)].map(
      (m) => m[1] as string,
    ),
    travelMode,
  };
}
