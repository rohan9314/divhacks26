import { fakeLlm } from "@mvp/core/testing";
import { describe, expect, it } from "vitest";
import { createTurnGraph, runTurn } from "../src";
import { COLUMBIA, deps, EVENT, FOOD, fakeSkills, NOW } from "./helpers";

const turn = (text: string, opts: { located?: boolean } = {}) => ({
  spaceId: "chat-1",
  text,
  now: NOW,
  recent: [],
  ...(opts.located !== false && { lastLocation: COLUMBIA }),
});

const ran = (skills: ReturnType<typeof fakeSkills>) =>
  Object.entries(skills.calls)
    .filter(([, calls]) => calls.length)
    .map(([name, calls]) => `${name}x${calls.length}`)
    .sort();

describe("routing (heuristic parser, no Gemini)", () => {
  const cases: Array<[string, string[]]> = [
    ["Is it safe around me?", ["safetyx1"]],
    ["Where should we get dinner?", ["foodx1", "routex1"]],
    ["What fun stuff is nearby tonight?", ["eventsx1", "routex1"]],
    ["How do I get to Jin Ramen?", ["routex1"]],
    ["Plan a fun and safe night near Columbia", ["eventsx1", "foodx1", "routex1", "safetyx1"]],
  ];
  for (const [text, expected] of cases) {
    it(`"${text}" runs only ${expected.join(", ")}`, async () => {
      const skills = fakeSkills();
      await runTurn(createTurnGraph(deps(skills)), turn(text));
      expect(ran(skills)).toEqual(expected);
    });
  }

  it("asks one question and calls no skills when there is no location", async () => {
    const skills = fakeSkills();
    const { reply } = await runTurn(
      createTurnGraph(deps(skills)),
      turn("Where should we get dinner?", { located: false }),
    );
    expect(reply).toMatch(/where are you/i);
    expect(ran(skills)).toEqual([]);
  });

  it("uses a named place over the last shared location", async () => {
    const skills = fakeSkills();
    await runTurn(createTurnGraph(deps(skills)), turn("dinner near Columbia", { located: false }));
    expect(skills.calls.food[0]).toMatchObject({ origin: COLUMBIA });
  });

  it("answers small talk with help and no skills", async () => {
    const skills = fakeSkills();
    const { reply } = await runTurn(createTurnGraph(deps(skills)), turn("hey!"));
    expect(reply).toMatch(/share your location/i);
    expect(ran(skills)).toEqual([]);
  });

  it("routes a night plan to the top event, once, after the other skills", async () => {
    const skills = fakeSkills();
    const { reply } = await runTurn(createTurnGraph(deps(skills)), turn("plan a night near Columbia"));
    expect(skills.calls.route).toHaveLength(1);
    expect(skills.calls.route[0]).toMatchObject({ destination: EVENT.location, travelMode: "WALK" });
    expect(reply).toContain("Route: 12 min walk to Riverside Park");
    expect(reply).toContain(FOOD.name);
    expect(reply).toMatch(/Historical reports/);
  });
});

describe("partial failure", () => {
  it("still answers when one skill throws, and says what is missing", async () => {
    const skills = fakeSkills({ events: "throw" });
    const { reply } = await runTurn(createTurnGraph(deps(skills)), turn("plan a night near Columbia"));
    expect(reply).toContain(FOOD.name);
    expect(reply).toMatch(/couldn't reach event listings/i);
  });

  it("times out a hanging skill without blocking the reply", async () => {
    const skills = fakeSkills({ safety: "hang" });
    const started = Date.now();
    const { reply } = await runTurn(createTurnGraph(deps(skills)), turn("plan a night near Columbia"));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(reply).toMatch(/couldn't reach historical safety data/i);
    expect(reply).toContain(EVENT.name);
  });

  it("says so when a requested search worked but found nothing", async () => {
    const skills = fakeSkills({
      events: () => ({
        status: "partial",
        data: [],
        sources: [],
        warnings: ["No official NYC events matched this time and place."],
      }),
    });
    const { reply } = await runTurn(createTurnGraph(deps(skills)), turn("plan a night near Columbia"));
    expect(reply).toContain("No official NYC events matched");
    expect(reply).toContain(FOOD.name);
  });

  it("gives a Maps link without a duration when routing fails", async () => {
    const skills = fakeSkills({ route: "throw" });
    const { reply } = await runTurn(createTurnGraph(deps(skills)), turn("Where should we get dinner?"));
    expect(reply).not.toMatch(/\d+ min/);
    expect(reply).toMatch(/couldn't reach travel times/i);
  });
});

describe("with Gemini", () => {
  const intent = (needs: string[], extra = {}) => ({
    needs,
    when: "now",
    categories: [],
    cuisine: [],
    travelMode: "WALK",
    ...extra,
  });

  it("uses the parsed intent to pick skills", async () => {
    const skills = fakeSkills();
    const llm = fakeLlm({
      parseIntent: () => intent(["safety"]),
      composeReply: () => ({ text: "Historical reports here are below average at 7 PM.", citedIds: [] }),
    });
    await runTurn(createTurnGraph(deps(skills, { llm })), turn("anything I should know about this block?"));
    expect(ran(skills)).toEqual(["safetyx1"]);
  });

  it("falls back to the keyword parser when Gemini fails", async () => {
    const skills = fakeSkills();
    const llm = fakeLlm({});
    await runTurn(createTurnGraph(deps(skills, { llm })), turn("Is it safe around me?"));
    expect(ran(skills)).toEqual(["safetyx1"]);
  });

  it("keeps a grounded Gemini draft and appends links in code", async () => {
    const skills = fakeSkills();
    const llm = fakeLlm({
      parseIntent: () => intent(["food"]),
      composeReply: () => ({ text: "Jin Ramen is open now and 0.6 mi away, 12 min on foot.", citedIds: [FOOD.id] }),
    });
    const { reply, state } = await runTurn(createTurnGraph(deps(skills, { llm })), turn("ramen?"));
    expect(state.draft?.source).toBe("gemini");
    expect(reply).toContain(`Jin Ramen: ${FOOD.url}`);
  });

  it("accepts a draft that shortens a long event name", async () => {
    const skills = fakeSkills({
      events: () => ({
        status: "ok",
        data: [{ ...EVENT, name: "Harlem Run: Monday Night Run" }],
        sources: [],
        warnings: [],
      }),
    });
    const llm = fakeLlm({
      parseIntent: () => intent(["events"]),
      composeReply: () => ({ text: "Join Harlem Run tonight.", citedIds: [EVENT.id] }),
    });
    const { state } = await runTurn(createTurnGraph(deps(skills, { llm })), turn("anything fun?"));
    expect(state.draft?.source).toBe("gemini");
  });

  it("describes an event already underway as on now", async () => {
    const skills = fakeSkills({
      events: () => ({
        status: "ok",
        data: [{ ...EVENT, startsAt: "2026-09-26T18:00:00.000Z", endsAt: "2026-09-27T00:00:00.000Z" }],
        sources: [],
        warnings: [],
      }),
    });
    const { reply } = await runTurn(createTurnGraph(deps(skills)), turn("what fun stuff is nearby tonight?"));
    expect(reply).toContain("on now until 8:00 PM");
  });

  const rejected: Array<[string, { text: string; citedIds: string[] }]> = [
    ["an invented id", { text: "Try Fake Diner.", citedIds: ["food:made-up"] }],
    ["its own link", { text: "Jin Ramen: https://evil.example", citedIds: [FOOD.id] }],
    ["a duration Routes didn't give", { text: "Jin Ramen is 5 minutes away.", citedIds: [FOOD.id] }],
    ["a cited id it never names", { text: "Great ramen nearby!", citedIds: [FOOD.id] }],
  ];
  for (const [what, draft] of rejected) {
    it(`replaces a draft with ${what} by the template`, async () => {
      const skills = fakeSkills();
      const llm = fakeLlm({ parseIntent: () => intent(["food"]), composeReply: () => draft });
      const { reply, state } = await runTurn(createTurnGraph(deps(skills, { llm })), turn("ramen?"));
      expect(state.draft?.source).toBe("template");
      expect(state.draft?.rejected).toBeTruthy();
      expect(reply).toContain("1. Jin Ramen");
      expect(reply).not.toContain("evil.example");
    });
  }
});
