import type { SkillContext } from "./contracts";
import type { Query } from "./db";
import { type JsonRequest, type Llm, LlmError, parseJson } from "./llm";
import { silentLogger } from "./log";

export function testContext(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    now: new Date("2026-09-26T23:00:00Z"),
    signal: new AbortController().signal,
    log: silentLogger,
    ...overrides,
  };
}

/** A fake LLM keyed by task name. Answers go through the same zod validation as real output. */
export function fakeLlm(answers: Record<string, (request: JsonRequest<unknown>) => unknown>): Llm & {
  calls: JsonRequest<unknown>[];
} {
  const calls: JsonRequest<unknown>[] = [];
  return {
    calls,
    async json<T>(request: JsonRequest<T>): Promise<T> {
      calls.push(request as JsonRequest<unknown>);
      const answer = answers[request.task];
      if (!answer) throw new LlmError(request.task, "provider", "no fake answer for this task");
      return parseJson(request, JSON.stringify(answer(request as JsonRequest<unknown>)));
    },
  };
}

/** A fetch that replies from a handler; records every call. */
export function fakeFetch(handler: (url: string, body: unknown) => Response | Promise<Response>): typeof fetch & {
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return handler(url, body);
  }) as typeof fetch & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A fake pg query that answers from a handler; records every call. */
export function fakeQuery(handler: (sql: string, values: unknown[]) => Record<string, unknown>[]): Query & {
  calls: Array<{ sql: string; values: unknown[] }>;
} {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const fn = (async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return { rows: handler(sql, values) };
  }) as Query & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}
