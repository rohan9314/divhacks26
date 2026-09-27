import { describe, expect, it } from "vitest";
import {
  createSite,
  MAX_ATTEMPTS,
  maskEmail,
  maskPhone,
  normalizeEmail,
  normalizeUsPhone,
  parsePhoneCodeText,
  RESEND_COOLDOWN_MS,
} from "../src/site";
import { createMemoryStore as createFakeStore } from "../src/testing";

function setup(maxUsers = 100) {
  let t = 1_000_000;
  const store = createFakeStore();
  const emailed: Record<string, string> = {};
  const texts: Array<{ phone: string; body: string }> = [];
  const site = createSite({
    store,
    secret: "test-secret",
    maxUsers,
    agentNumber: "+15555550100",
    sendText: async (phone, body) => {
      texts.push({ phone, body });
    },
    now: () => t,
    sendEmailCode: async (email, code) => {
      emailed[email] = code;
    },
  });
  /** Email → text the shown code from the phone → poll. Returns the signed-in result. */
  const signUp = async (email: string, phone: string) => {
    t += RESEND_COOLDOWN_MS + 1;
    await site.startEmail(email);
    const { challenge } = await site.verifyEmail(email, emailed[normalizeEmail(email)!]);
    const { code } = await site.startPhone(challenge, phone);
    expect(await site.confirmPhoneText(normalizeUsPhone(phone)!, `CODE ${code}`)).toMatch(/^You're verified!/);
    const result = await site.verifyPhone(challenge, phone);
    if (!("token" in result)) throw new Error("still pending");
    return result;
  };
  return { store, site, emailed, texts, signUp, advance: (ms: number) => (t += ms) };
}

describe("website sign-in (moved from DeepSpace)", () => {
  it("runs email code → iMessage code → account + session", async () => {
    const { store, site, texts, signUp } = setup();
    const { token, user } = await signUp("Keith@Example.com", "(917) 782-4515");
    expect(user).toEqual({
      phone: maskPhone("+19177824515"),
      email: maskEmail("keith@example.com"),
      onboarded: false,
      preferences: null,
      wallet: { status: "none" },
    });
    expect((await site.session(token))?.email).toBe("keith@example.com");
    expect(await site.stats()).toEqual({ spotsTaken: 1, spotsTotal: 100 });

    // Nothing is sent to the phone: the person texts the bot instead.
    expect(texts).toHaveLength(0);

    // Only hashes are stored.
    const stored = JSON.stringify(["site_codes", "site_sessions", "site_challenges"].map((c) => store.rows(c)));
    expect(stored).not.toContain(token);
  });

  it("shows a code and @agent's number, then waits for the person to text it", async () => {
    const { site, emailed } = setup();
    await site.startEmail("p@example.com");
    const { challenge } = await site.verifyEmail("p@example.com", emailed["p@example.com"]);
    const started = await site.startPhone(challenge, "9175550120");
    expect(started).toMatchObject({ ok: true, agentNumber: "+15555550100" });
    expect(started.code).toMatch(/^\d{6}$/);
    expect(await site.verifyPhone(challenge, "9175550120")).toEqual({ pending: true });

    // Wrong code, another number, and an email sender don't verify it.
    expect(await site.confirmPhoneText("+19175550120", "CODE 000000")).toMatch(/doesn't match/);
    expect(await site.confirmPhoneText("+19175550199", `CODE ${started.code}`)).toMatch(/don't see a sign-in/);
    expect(await site.confirmPhoneText("p@icloud.com", `CODE ${started.code}`)).toMatch(/from the phone number/);
    expect(await site.verifyPhone(challenge, "9175550120")).toEqual({ pending: true });

    // Ordinary chat isn't treated as a code.
    expect(await site.confirmPhoneText("+19175550120", "where should we eat")).toBeNull();

    expect(await site.confirmPhoneText("+19175550120", `code: ${started.code}`)).toMatch(/^You're verified!/);
    const done = await site.verifyPhone(challenge, "9175550120");
    expect("token" in done).toBe(true);
    // One sign-in per text.
    await expect(site.verifyPhone(challenge, "9175550120")).rejects.toMatchObject({ code: "challenge_expired" });
  });

  it("shows each person their own @agent number, and fails clearly without one", async () => {
    const store = createFakeStore();
    const emailed: Record<string, string> = {};
    const numbers: Record<string, string> = { "+19175550130": "+14155550030", "+19175550131": "+14155550031" };
    const make = (agentNumberFor?: (p: string) => Promise<string | null>) =>
      createSite({
        store,
        secret: "s",
        maxUsers: 100,
        agentNumberFor,
        sendEmailCode: async (e, c) => {
          emailed[e] = c;
        },
      });
    const site = make(async (phone) => numbers[phone] ?? null);
    for (const [phone, agent] of Object.entries(numbers)) {
      const email = `${phone.slice(-4)}@example.com`;
      await site.startEmail(email);
      const { challenge } = await site.verifyEmail(email, emailed[email]);
      expect((await site.startPhone(challenge, phone)).agentNumber).toBe(agent);
    }
    const broken = make(async () => {
      throw new Error("photon down");
    });
    await broken.startEmail("x@example.com");
    const { challenge } = await broken.verifyEmail("x@example.com", emailed["x@example.com"]);
    await expect(broken.startPhone(challenge, "9175550132")).rejects.toMatchObject({ code: "number_unavailable" });
  });

  it("reads code texts loosely but not ordinary numbers", () => {
    expect(parsePhoneCodeText("CODE 482913")).toBe("482913");
    expect(parsePhoneCodeText(" code:482-913 ")).toBe("482913");
    expect(parsePhoneCodeText("482913")).toBe("482913");
    expect(parsePhoneCodeText("meet at 482913 broadway")).toBeNull();
    expect(parsePhoneCodeText("CODE 4829")).toBeNull();
  });

  it("locks a phone code after too many wrong texts", async () => {
    const { site, emailed } = setup();
    await site.startEmail("r@example.com");
    const { challenge } = await site.verifyEmail("r@example.com", emailed["r@example.com"]);
    const { code } = await site.startPhone(challenge, "9175550122");
    for (let i = 0; i < MAX_ATTEMPTS; i++) await site.confirmPhoneText("+19175550122", "CODE 000000");
    expect(await site.confirmPhoneText("+19175550122", `CODE ${code}`)).toMatch(/Too many tries/);
  });

  it("rejects wrong codes, then locks after too many tries", async () => {
    const { site, emailed } = setup();
    await site.startEmail("a@example.com");
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      await expect(site.verifyEmail("a@example.com", "000000")).rejects.toMatchObject({ code: "wrong_code" });
    }
    await expect(site.verifyEmail("a@example.com", "000000")).rejects.toMatchObject({ code: "too_many_attempts" });
    await expect(site.verifyEmail("a@example.com", emailed["a@example.com"])).rejects.toMatchObject({
      code: "too_many_attempts",
    });
  });

  it("expires codes and never accepts one twice", async () => {
    const { site, emailed, advance } = setup();
    await site.startEmail("b@example.com");
    const code = emailed["b@example.com"];
    await site.verifyEmail("b@example.com", code);
    await expect(site.verifyEmail("b@example.com", code)).rejects.toMatchObject({ code: "no_code" });

    advance(RESEND_COOLDOWN_MS + 1);
    await site.startEmail("b@example.com");
    advance(11 * 60 * 1000);
    await expect(site.verifyEmail("b@example.com", emailed["b@example.com"])).rejects.toMatchObject({
      code: "expired",
    });
  });

  it("does not count a failed send toward the rate limit", async () => {
    const { store } = setup();
    let fail = true;
    const site = createSite({
      store,
      secret: "s",
      maxUsers: 100,
      sendEmailCode: async () => {
        if (fail) throw new Error("provider down");
      },
    });
    await expect(site.startEmail("z@example.com")).rejects.toMatchObject({ code: "send_failed" });
    fail = false;
    await expect(site.startEmail("z@example.com")).resolves.toEqual({ ok: true });
  });

  it("rate-limits resends", async () => {
    const { site } = setup();
    await site.startEmail("c@example.com");
    await expect(site.startEmail("c@example.com")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("needs a verified email before texting a number", async () => {
    const { site } = setup();
    await expect(site.startPhone("not-a-challenge", "9175550101")).rejects.toMatchObject({ code: "challenge_expired" });
    await expect(site.startPhone("x", "123")).rejects.toMatchObject({ code: "invalid_phone" });
  });

  it("keeps one account per email and number, and enforces the cap", async () => {
    const { site, signUp } = setup(1);
    await signUp("d@example.com", "9175550101");
    await expect(signUp("e@example.com", "9175550101")).rejects.toMatchObject({ code: "account_mismatch" });
    await expect(signUp("e@example.com", "9175550102")).rejects.toMatchObject({ code: "full" });
    // The same person signing in again is fine even when full.
    const again = await signUp("d@example.com", "9175550101");
    expect(await site.session(again.token)).not.toBeNull();
  });

  it("saves preferences, signs out, and deletes the account", async () => {
    const { site, signUp } = setup();
    const { token } = await signUp("f@example.com", "9175550103");
    const user = (await site.session(token))!;
    await site.savePreferences(user.phone, { name: " Ana ", dietary: ["vegetarian"], budget: "low" });
    const saved = (await site.session(token))!;
    expect(saved.preferences).toMatchObject({
      name: "Ana",
      dietary: ["vegetarian"],
      budget: "low",
      voiceReplies: "match",
    });
    expect(saved.onboardedAt).toBeTruthy();
    await expect(site.savePreferences(user.phone, { name: "" })).rejects.toMatchObject({ code: "invalid_preferences" });

    await site.signOut(token);
    expect(await site.session(token)).toBeNull();

    const second = await signUp("f@example.com", "9175550103");
    await site.deleteUser(user.phone);
    expect(await site.session(second.token)).toBeNull();
    expect(await site.stats()).toEqual({ spotsTaken: 0, spotsTotal: 100 });
  });

  it("sends a hello iMessage and adds people to the waitlist", async () => {
    const { site, emailed, texts, signUp } = setup();
    const { token } = await signUp("g@example.com", "9175550104");
    const user = (await site.session(token))!;
    await site.startChat(user);
    expect(texts.at(-1)).toMatchObject({ phone: "+19175550104", body: expect.stringMatching(/^Hi! This is @agent/) });

    await site.startEmail("h@example.com");
    const { challenge } = await site.verifyEmail("h@example.com", emailed["h@example.com"]);
    expect(await site.joinWaitlist(challenge, "9175550105", "Hal")).toEqual({ position: 1 });
    expect(await site.joinWaitlist(challenge, "9175550105", "Hal")).toEqual({ position: 1 });
  });

  it("reports a failed hello text instead of pretending it was sent", async () => {
    const store = createFakeStore();
    const emailed: Record<string, string> = {};
    const site = createSite({
      store,
      secret: "s",
      maxUsers: 100,
      agentNumber: "+15555550100",
      sendText: async () => {
        throw new Error("photon down");
      },
      sendEmailCode: async (e, c) => {
        emailed[e] = c;
      },
    });
    await site.startEmail("i@example.com");
    const { challenge } = await site.verifyEmail("i@example.com", emailed["i@example.com"]);
    const { code } = await site.startPhone(challenge, "9175550106");
    await site.confirmPhoneText("+19175550106", `CODE ${code}`);
    const done = await site.verifyPhone(challenge, "9175550106");
    if (!("token" in done)) throw new Error("still pending");
    const user = (await site.session(done.token))!;
    await expect(site.startChat(user)).rejects.toMatchObject({ code: "send_failed" });
  });
});
