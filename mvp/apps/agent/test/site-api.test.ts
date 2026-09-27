import { createSite } from "@mvp/accounts";
import { createMemoryStore } from "@mvp/accounts/testing";
import { silentLogger } from "@mvp/core";
import { createTurnGraph } from "@mvp/router";
import { describe, expect, it } from "vitest";
import { fakeSkills } from "../../../packages/router/test/helpers";
import type { ChannelAdapter } from "../src/channel";
import { createMemoryContextStore } from "../src/context-store";
import { createSiteApi } from "../src/site-api";
import { createTurnHandler } from "../src/turn";

const SITE = "https://plansaroundus.tech";

function setup(options: { configured?: boolean } = {}) {
  const emails: Array<{ to: string; subject: string; text: string }> = [];
  const chat: string[] = [];
  const hellos: Array<{ phone: string; body: string }> = [];
  const channel: ChannelAdapter = {
    name: "fake",
    start: async () => {},
    send: async (_space, text) => {
      chat.push(text);
    },
    sendTo: async (phone, body) => {
      hellos.push({ phone, body });
    },
  };
  const site =
    options.configured === false
      ? null
      : createSite({
          store: createMemoryStore(),
          secret: "x".repeat(32),
          maxUsers: 100,
          agentNumberFor: async () => "+14155550030",
          sendText: channel.sendTo,
          sendEmailCode: async (email, code) => {
            emails.push({ to: email, subject: code, text: code });
          },
        });
  const api = createSiteApi({
    site,
    agentNumberFor: async () => "+14155550030",
    sendEmail: async (message) => {
      emails.push(message);
    },
    integrations: () => [],
    health: () => ({ status: "ok" }),
    allowedOrigins: [SITE],
    log: silentLogger,
  });
  const handle = createTurnHandler({
    graph: createTurnGraph({ skills: fakeSkills().registry, log: silentLogger }),
    store: createMemoryContextStore(),
    channel,
    agentName: "agent",
    log: silentLogger,
    ...(site && { confirmSignIn: (sender: string, text: string) => site.confirmPhoneText(sender, text) }),
  });
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await api.request(path, {
      method,
      headers: {
        Origin: SITE,
        "Content-Type": "application/json",
        ...(token && { Authorization: `Bearer ${token}` }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown>, res };
  };
  return { api, call, handle, emails, chat, hellos };
}

describe("website API (moved from DeepSpace)", () => {
  it("signs up end to end: email code → text CODE to @agent → poll → account", async () => {
    const { call, handle, emails, chat, hellos } = setup();

    expect((await call("POST", "/api/auth/email/start", { email: "Keith@Example.com" })).status).toBe(200);
    const emailCode = emails.at(-1)?.subject;
    const { body: verified } = await call("POST", "/api/auth/email/verify", {
      email: "keith@example.com",
      code: emailCode,
    });
    const challenge = verified.challenge as string;

    const { body: started } = await call("POST", "/api/auth/phone/start", { challenge, phone: "(917) 555-0120" });
    expect(started).toMatchObject({ ok: true, agentNumber: "+14155550030", code: expect.stringMatching(/^\d{6}$/) });
    expect((await call("POST", "/api/auth/phone/verify", { challenge, phone: "9175550120" })).body).toEqual({
      pending: true,
    });

    // The person texts the code to @agent; the turn handler verifies it in process.
    await handle("dm", [
      {
        spaceId: "dm",
        messageId: "m1",
        text: `CODE ${started.code}`,
        isGroup: false,
        senderAddress: "+19175550120",
      },
    ]);
    expect(chat.at(-1)).toMatch(/^You're verified!/);

    const { body: done } = await call("POST", "/api/auth/phone/verify", { challenge, phone: "9175550120" });
    const token = done.token as string;
    expect(done.user).toMatchObject({ phone: "+1 •••-•••-0120", onboarded: false });

    expect((await call("GET", "/api/me", undefined, token)).body).toMatchObject({ email: "k•••@example.com" });
    await call("PUT", "/api/me/preferences", { name: "Keith", dietary: [] }, token);
    expect((await call("GET", "/api/me", undefined, token)).body).toMatchObject({ onboarded: true });
    expect((await call("GET", "/api/stats")).body).toEqual({ spotsTaken: 1, spotsTotal: 100 });

    expect((await call("POST", "/api/me/start-chat", undefined, token)).status).toBe(200);
    expect(hellos.at(-1)).toMatchObject({ phone: "+19175550120", body: expect.stringMatching(/^Hi Keith!/) });

    expect((await call("POST", "/api/me/send-number", undefined, token)).status).toBe(200);
    expect(emails.at(-1)?.text).toContain("+14155550030");

    expect((await call("DELETE", "/api/me", undefined, token)).status).toBe(200);
    expect((await call("GET", "/api/me", undefined, token)).status).toBe(401);
  });

  it("does not treat a code text from a group chat or without a sender as sign-in", async () => {
    const { handle, chat } = setup();
    await handle("g", [
      { spaceId: "g", messageId: "m", text: "CODE 123456", isGroup: true, senderAddress: "+19175550120" },
    ]);
    await handle("dm", [{ spaceId: "dm", messageId: "n", text: "CODE 123456", isGroup: false }]);
    expect(chat.some((line) => /verified|sign-in/i.test(line))).toBe(false);
  });

  it("answers with the site's error codes and statuses", async () => {
    const { call } = setup();
    expect(await call("GET", "/api/me")).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    expect(await call("POST", "/api/auth/email/start", { email: "nope" })).toMatchObject({
      status: 400,
      body: { error: "invalid_email" },
    });
    expect((await call("GET", "/api/xrpl/dashboard")).status).toBe(503);
    const bad = await call("POST", "/api/auth/email/start", "{");
    expect(bad.status).toBe(400);
  });

  it("reports site_unconfigured when sign-in isn't set up", async () => {
    const { call } = setup({ configured: false });
    expect(await call("GET", "/api/stats")).toMatchObject({ status: 503, body: { error: "site_unconfigured" } });
  });

  it("allows only the website's origin", async () => {
    const { api } = setup();
    const preflight = (origin: string) =>
      api.request("/api/me", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "GET" },
      });
    expect((await preflight(SITE)).headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect((await preflight("https://evil.example")).headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("serves /healthz", async () => {
    const { api } = setup();
    expect(await (await api.request("/healthz")).json()).toEqual({ status: "ok" });
  });
});
