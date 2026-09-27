import { silentLogger } from "@mvp/core";
import { createTurnGraph } from "@mvp/router";
import { describe, expect, it } from "vitest";
import { COLUMBIA, fakeSkills, NOW } from "../../../packages/router/test/helpers";
import type { ChannelAdapter, InboundMessage } from "../src/channel";
import { mentionOf } from "../src/channel";
import { createMemoryContextStore, withFallback } from "../src/context-store";
import { createInbox } from "../src/inbox";
import { createTurnHandler } from "../src/turn";

const msg = (text: string, extra: Partial<InboundMessage> = {}): InboundMessage => ({
  spaceId: "chat-1",
  messageId: `${Math.random()}`,
  text,
  isGroup: false,
  ...extra,
});

function setup(behaviors: Parameters<typeof fakeSkills>[0] = {}) {
  const skills = fakeSkills(behaviors);
  const sent: string[] = [];
  const channel: ChannelAdapter = {
    name: "fake",
    start: async () => {},
    send: async (_space, text) => {
      sent.push(text);
    },
  };
  const store = createMemoryContextStore();
  const graph = createTurnGraph({ skills: skills.registry, log: silentLogger });
  const handle = createTurnHandler({ graph, store, channel, agentName: "agent", log: silentLogger, now: () => NOW });
  return { skills, sent, store, handle };
}

describe("turn handler", () => {
  it("uses a location shared in the same batch", async () => {
    const { handle, sent, skills } = setup();
    await handle("chat-1", [msg("", { location: COLUMBIA }), msg("where should we get dinner?")]);
    expect(sent).toHaveLength(1);
    expect(skills.calls.food[0]).toMatchObject({ origin: { latitude: COLUMBIA.latitude } });
  });

  it("remembers a location pin without replying to it", async () => {
    const { handle, sent, store } = setup();
    await handle("chat-1", [msg("", { location: COLUMBIA })]);
    expect(sent).toEqual([]);
    expect((await store.get("chat-1")).lastLocation?.latitude).toBe(COLUMBIA.latitude);
  });

  it("ignores group chatter that doesn't mention the agent", async () => {
    const { handle, sent } = setup();
    await handle("g", [msg("where should we eat lol", { isGroup: true, spaceId: "g" })]);
    expect(sent).toEqual([]);
  });

  it("answers a group mention with the mention stripped", async () => {
    const { handle, sent, skills } = setup();
    await handle("g", [
      msg("", { isGroup: true, location: COLUMBIA }),
      msg("@agent where should we eat?", { isGroup: true }),
    ]);
    expect(sent).toHaveLength(1);
    expect(skills.calls.food[0]).toMatchObject({ request: "where should we eat?" });
  });

  it("asks for a location when the chat has none", async () => {
    const { handle, sent, skills } = setup();
    await handle("chat-1", [msg("dinner?")]);
    expect(sent[0]).toMatch(/where are you/i);
    expect(skills.calls.food).toHaveLength(0);
  });
});

describe("inbox", () => {
  it("batches quick messages per chat and drops redeliveries", async () => {
    const batches: string[][] = [];
    const inbox = createInbox({
      delayMs: 20,
      process: async (_space, batch) => {
        batches.push(batch.map((m) => m.text));
      },
      onError: () => {},
    });
    const first = msg("dinner?");
    inbox.push(first);
    inbox.push(first);
    inbox.push(msg("somewhere cheap"));
    inbox.push(msg("other chat", { spaceId: "chat-2" }));
    await new Promise((r) => setTimeout(r, 60));
    await inbox.drain();
    expect(batches).toEqual([["dinner?", "somewhere cheap"], ["other chat"]]);
  });
});

describe("mentions", () => {
  it("matches @name case-insensitively and strips it", () => {
    expect(mentionOf("agent")("@Agent, plan tonight")).toEqual({ mentioned: true, request: "plan tonight" });
    expect(mentionOf("agent")("the agent said so").mentioned).toBe(false);
  });
});

describe("context store", () => {
  it("falls back to memory when the database store fails", async () => {
    const broken = {
      get: async () => Promise.reject(new Error("relation does not exist")),
      recordLocation: async () => Promise.reject(new Error("down")),
      recordLine: async () => Promise.reject(new Error("down")),
    };
    const errors: unknown[] = [];
    const store = withFallback(broken, createMemoryContextStore(), (e) => errors.push(e));
    await store.recordLocation("c", COLUMBIA);
    expect((await store.get("c")).lastLocation?.latitude).toBe(COLUMBIA.latitude);
    expect(errors).toHaveLength(2);
  });

  it("forgets a location after six hours", async () => {
    let now = 0;
    const store = createMemoryContextStore(() => now);
    await store.recordLocation("c", COLUMBIA);
    now = 7 * 3_600_000;
    expect((await store.get("c")).lastLocation).toBeUndefined();
  });
});
