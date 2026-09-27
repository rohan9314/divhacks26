import type {
  EventRecommendation,
  FoodRecommendation,
  Logger,
  RouteResult,
  SafetySummary,
  Skill,
  SkillName,
  SkillResult,
} from "@mvp/core";
import { unavailable } from "@mvp/core";

/** The four skills, wired with their credentials in apps/agent. */
export interface SkillRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: each skill has its own input type; the dispatcher validates it.
  safety: Skill<any, SafetySummary | null>;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  events: Skill<any, EventRecommendation[]>;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  food: Skill<any, FoodRecommendation[]>;
  // biome-ignore lint/suspicious/noExplicitAny: see above
  route: Skill<any, RouteResult>;
}

export interface Results {
  safety?: SkillResult<SafetySummary | null>;
  events?: SkillResult<EventRecommendation[]>;
  food?: SkillResult<FoodRecommendation[]>;
  route?: SkillResult<RouteResult | null>;
}

const EMPTY: { [K in SkillName]: NonNullable<Results[K]>["data"] } = {
  safety: null,
  events: [],
  food: [],
  route: null,
};

/**
 * Run one skill behind the contract: validate input, enforce the timeout, and turn any throw into
 * `unavailable` so one broken skill never fails the whole reply.
 */
export async function runSkill<K extends SkillName>(
  name: K,
  skill: SkillRegistry[K],
  raw: unknown,
  opts: { now: Date; log: Logger },
): Promise<NonNullable<Results[K]>> {
  const empty = EMPTY[name] as NonNullable<Results[K]>["data"];
  const parsed = skill.input.safeParse(raw);
  if (!parsed.success) {
    opts.log.warn({ skill: name, issues: parsed.error.issues.length }, "skill input rejected");
    return unavailable(empty, `${name} could not run with this request.`) as NonNullable<Results[K]>;
  }
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, skill.timeoutMs);
  });
  const started = Date.now();
  try {
    const result = await Promise.race([
      skill.run(parsed.data, { now: opts.now, signal: controller.signal, log: opts.log }),
      timeout,
    ]);
    opts.log.info({ skill: name, status: result.status, ms: Date.now() - started }, "skill finished");
    return result as NonNullable<Results[K]>;
  } catch (error) {
    const timedOut = controller.signal.aborted;
    opts.log.warn({ skill: name, timedOut, err: (error as Error).message }, "skill failed");
    return unavailable(
      empty,
      timedOut ? `${name} took too long to answer.` : `${name} is temporarily unavailable.`,
    ) as NonNullable<Results[K]>;
  } finally {
    clearTimeout(timer);
  }
}
