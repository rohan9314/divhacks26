import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";
import {
  distanceMeters,
  type Geocoder,
  type Llm,
  type Location,
  type Logger,
  requestedHour,
  type SkillName,
  type TravelMode,
  timeWindow,
  type UserIntent,
} from "@mvp/core";
import { checkDraft, composeWithGemini, type Draft, factsFor, finalize, templateDraft } from "./compose";
import { type Results, runSkill, type SkillRegistry } from "./dispatch";
import { parseIntent } from "./intent";

export interface TurnInput {
  spaceId: string;
  text: string;
  now: Date;
  /** Last location shared in this chat, if any. */
  lastLocation?: Location;
  /** Recent message lines for intent context (no sender identifiers). */
  recent: string[];
}

export interface RouterDeps {
  skills: SkillRegistry;
  llm?: Llm;
  geocode?: Geocoder;
  log: Logger;
}

type Outcome = "dispatch" | "clarify" | "help";

const TurnState = Annotation.Root({
  input: Annotation<TurnInput>(),
  intent: Annotation<UserIntent>(),
  intentSource: Annotation<"gemini" | "heuristic">(),
  outcome: Annotation<Outcome>(),
  origin: Annotation<Location | undefined>(),
  destination: Annotation<Location | undefined>(),
  // Parallel skill branches each write their own key; the reducer merges them.
  results: Annotation<Results>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
  ran: Annotation<SkillName[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  draft: Annotation<Draft | undefined>(),
  reply: Annotation<string>(),
});

export type TurnState = typeof TurnState.State;
type SkillBranch = TurnState & { skill: Exclude<SkillName, "route"> };

const HELP =
  'I can find things to do, food, historical safety context and routes around you. Share your location or tell me where you are, e.g. "dinner near Columbia".';

/** WALK is the default; past ~3 km a walk is not a realistic suggestion, so use transit. */
function sensibleMode(mode: TravelMode, from: Location, to: Location): TravelMode {
  return mode === "WALK" && distanceMeters(from, to) > 3_000 ? "TRANSIT" : mode;
}

export function createTurnGraph(deps: RouterDeps) {
  const { log } = deps;

  const geocode = async (query: string | undefined): Promise<Location | undefined> => {
    if (!query || !deps.geocode) return undefined;
    try {
      return (await deps.geocode(query)) ?? undefined;
    } catch (error) {
      log.warn({ err: (error as Error).message }, "geocode failed");
      return undefined;
    }
  };

  const graph = new StateGraph(TurnState)
    .addNode("parseIntent", async (s: TurnState) => {
      const { intent, source } = await parseIntent(s.input.text, s.input.recent, deps.llm);
      log.info({ needs: intent.needs, source }, "intent parsed");
      return { intent, intentSource: source };
    })
    .addNode("resolveLocations", async (s: TurnState) => {
      const { intent } = s;
      if (!intent.needs.length) return { outcome: "help" as const, reply: HELP };
      const [named, destination] = await Promise.all([geocode(intent.locationQuery), geocode(intent.destinationQuery)]);
      const origin = named ?? s.input.lastLocation;
      if (!origin) {
        const where = intent.locationQuery ? `I couldn't find "${intent.locationQuery}". ` : "";
        return {
          outcome: "clarify" as const,
          reply: `${where}Where are you? Share your location or name a place, e.g. "near Union Square".`,
        };
      }
      const onlyRoute = intent.needs.length === 1 && intent.needs[0] === "route";
      if (onlyRoute && !destination) {
        const which = intent.destinationQuery ? `I couldn't find "${intent.destinationQuery}". ` : "";
        return { outcome: "clarify" as const, reply: `${which}Where do you want to go?` };
      }
      return { outcome: "dispatch" as const, origin, destination };
    })
    .addNode("runSkill", async (s: SkillBranch) => {
      const { intent, input, origin } = s;
      const raw = {
        safety: { origin, hourEt: requestedHour(intent.when, input.now) },
        events: { origin, ...timeWindow(intent.when, input.now), categories: intent.categories, budget: intent.budget },
        food: {
          origin,
          cuisine: intent.cuisine,
          budget: intent.budget,
          openNow: /^(now|tonight|)$/i.test(intent.when.trim()),
          request: input.text,
        },
      }[s.skill];
      const result = await runSkill(s.skill, deps.skills[s.skill], raw, { now: input.now, log });
      return { results: { [s.skill]: result }, ran: [s.skill] };
    })
    .addNode("route", async (s: TurnState) => {
      const { intent, results, origin } = s;
      if (!origin) return {};
      // Explicit destination first; otherwise the top pick, event before food (plan order).
      const target =
        s.destination ??
        (intent.needs.includes("events") ? results.events?.data[0]?.location : undefined) ??
        results.food?.data[0]?.location;
      if (!target) return {};
      const travelMode = sensibleMode(intent.travelMode, origin, target);
      const result = await runSkill(
        "route",
        deps.skills.route,
        { origin, destination: target, travelMode, departureTime: s.input.now.toISOString() },
        { now: s.input.now, log },
      );
      return { results: { route: result }, ran: ["route"] };
    })
    .addNode("compose", async (s: TurnState) => {
      const origin = s.origin as Location;
      const needs = [...new Set([...s.intent.needs, ...s.ran])];
      const template = templateDraft({ origin, needs, results: s.results, now: s.input.now });
      if (!deps.llm) return { draft: template };
      try {
        const draft = await composeWithGemini(
          deps.llm,
          factsFor({ text: s.input.text, origin, needs, results: s.results, now: s.input.now }),
        );
        return { draft: { ...draft, source: "gemini" as const } };
      } catch (error) {
        log.warn({ err: (error as Error).message }, "compose failed; using template");
        return { draft: { ...template, rejected: "compose failed" } };
      }
    })
    .addNode("check", async (s: TurnState) => {
      const needs = [...new Set([...s.intent.needs, ...s.ran])];
      let draft = s.draft as Draft;
      if (draft.source === "gemini") {
        const verdict = checkDraft(draft, s.results);
        if (!verdict.ok) {
          log.warn({ reason: verdict.reason }, "gemini draft rejected by grounding check");
          draft = {
            ...templateDraft({ origin: s.origin as Location, needs, results: s.results, now: s.input.now }),
            rejected: verdict.reason,
          };
        }
      }
      return { draft, reply: finalize(draft, { needs, results: s.results }) };
    })
    .addEdge(START, "parseIntent")
    .addEdge("parseIntent", "resolveLocations")
    .addConditionalEdges("resolveLocations", (s: TurnState) => {
      if (s.outcome !== "dispatch") return END;
      const branches = s.intent.needs.filter((n): n is SkillBranch["skill"] => n !== "route");
      if (!branches.length) return "route";
      return branches.map((skill) => new Send("runSkill", { ...s, skill }));
    })
    .addEdge("runSkill", "route")
    .addEdge("route", "compose")
    .addEdge("compose", "check")
    .addEdge("check", END);

  return graph.compile();
}

export interface TurnResult {
  reply: string;
  state: TurnState;
}

export async function runTurn(graph: ReturnType<typeof createTurnGraph>, input: TurnInput): Promise<TurnResult> {
  const state = (await graph.invoke({ input })) as TurnState;
  return { reply: state.reply, state };
}
