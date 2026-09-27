import { describe, expect, it, vi } from "vitest";
import { runConversationTurn } from "../src/agent/turn.js";
import {
  collectInviteContacts,
  extractInviteeNames,
  formatGuestInvite,
  type InviteContact,
  isPlanInviteRequest,
  planQuestionForInvite,
  resolveInviteContact,
} from "../src/meetup/invite.js";
import { handlePlanInvite } from "../src/meetup/plan-invite.js";

describe("plan invite parsing", () => {
  it("reads invitees from a 1:1 plan request", () => {
    expect(isPlanInviteRequest("make a plan with Rohan")).toBe(true);
    expect(extractInviteeNames("make a plan with Rohan tonight")).toEqual(["Rohan"]);
    expect(extractInviteeNames("plan with Rohan and Keith near Columbia")).toEqual(["Rohan", "Keith"]);
    expect(planQuestionForInvite("make a plan with Rohan tonight near Columbia")).toMatch(/tonight near Columbia/i);
  });

  it("does not treat a solo night plan as an invite", () => {
    expect(isPlanInviteRequest("Plan a fun and safe night near Columbia")).toBe(false);
    expect(extractInviteeNames("what should we do tonight?")).toEqual([]);
  });

  it("treats a named shared plan as an invite even without 'make a plan'", () => {
    expect(isPlanInviteRequest("plan a night with Rohan near Columbia")).toBe(true);
    expect(isPlanInviteRequest("dinner with Rohan tonight")).toBe(true);
    expect(extractInviteeNames("Keith and I need a plan tonight", ["Keith"])).toEqual(["Keith"]);
  });

  it("matches a first name against the invite directory", () => {
    const contacts = [
      { displayName: "Rohan Sharma", photonSenderId: "rohan-id" },
      { displayName: "Alan", photonSenderId: "alan-id" },
    ];
    expect(resolveInviteContact("Rohan", contacts)).toEqual(contacts[0]);
    expect(resolveInviteContact("Sam", contacts)).toBeUndefined();
  });

  it("matches any Tiger-linked first name, not only Rohan", () => {
    const contacts = collectInviteContacts({
      onboarded: [{ displayName: "User abc123", photonSenderId: "keith-id", userId: "u-keith" }],
      directory: [],
      tiger: [{ displayName: "Keith", userId: "u-keith" }],
    });
    expect((resolveInviteContact("Keith", contacts) as InviteContact | undefined)?.photonSenderId).toBe("keith-id");
  });

  it("texts a Tiger person whose user id is already a Photon handle", () => {
    const contacts = collectInviteContacts({
      onboarded: [],
      directory: [],
      tiger: [{ displayName: "Mike", userId: "photon:+15555550123" }],
    });
    expect((resolveInviteContact("Mike", contacts) as InviteContact | undefined)?.photonSenderId).toBe("+15555550123");
  });

  it("still texts Mike when another onboarded person has a wallet but no Photon handle", () => {
    const contacts = collectInviteContacts({
      onboarded: [
        { displayName: "Keith", userId: "site:keith" },
        { displayName: "Mike", photonSenderId: "+15555550123", userId: "photon:+15555550123" },
      ],
      directory: [],
      tiger: [
        { displayName: "Keith", userId: "site:keith" },
        { displayName: "Mike", userId: "photon:+15555550123" },
      ],
    });
    expect((resolveInviteContact("Mike", contacts) as InviteContact | undefined)?.photonSenderId).toBe("+15555550123");
    expect(resolveInviteContact("Keith", contacts)).toBeUndefined();
  });

  it("still texts Alan and Rohan when Keith has no Photon handle", () => {
    const contacts = collectInviteContacts({
      onboarded: [
        { displayName: "Alan", photonSenderId: "alan-id", userId: "photon:alan-id" },
        { displayName: "Rohan", photonSenderId: "rohan-id", userId: "photon:rohan-id" },
        { displayName: "Keith", userId: "site:keith" },
      ],
      directory: [{ displayName: "Rohan", userId: "photon:rohan-id", photonIdentifier: "rohan-id" }],
      tiger: [
        { displayName: "Alan", userId: "photon:alan-id" },
        { displayName: "Rohan", userId: "photon:rohan-id" },
        { displayName: "Keith", userId: "site:keith" },
      ],
    });
    expect((resolveInviteContact("Alan", contacts) as InviteContact | undefined)?.photonSenderId).toBe("alan-id");
    expect((resolveInviteContact("Rohan", contacts) as InviteContact | undefined)?.photonSenderId).toBe("rohan-id");
    expect(resolveInviteContact("Keith", contacts)).toBeUndefined();
  });
});

describe("plan invite send", () => {
  it("builds a plan and texts the invitee over Photon", async () => {
    const sendInvite = vi.fn(async (_to: string, _body: string) => undefined);
    const result = await handlePlanInvite({
      spaceId: "dm-alan",
      senderId: "alan-id",
      senderName: "Alan",
      text: "make a plan with Rohan tonight",
      isGroup: false,
      contacts: [{ displayName: "Rohan", photonSenderId: "rohan-id" }],
      buildPlan: async () => "Dinner at Jin Ramen at 8.",
      sendInvite,
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toContain("Dinner at Jin Ramen at 8.");
    expect(result.reply).toMatch(/I texted Rohan an invite/i);
    expect(sendInvite).toHaveBeenCalledOnce();
    expect(sendInvite.mock.calls[0]?.[0]).toBe("rohan-id");
    expect(sendInvite.mock.calls[0]?.[1]).toBe(formatGuestInvite("Alan", "Dinner at Jin Ramen at 8."));
  });

  it("does not claim a send when the person is not in the Photon directory", async () => {
    const sendInvite = vi.fn(async (_to: string, _body: string) => undefined);
    const result = await handlePlanInvite({
      spaceId: "dm-alan",
      senderId: "alan-id",
      senderName: "Alan",
      text: "make a plan with Rohan",
      isGroup: false,
      contacts: [],
      buildPlan: async () => "Walk the High Line.",
      sendInvite,
    });

    expect(sendInvite).not.toHaveBeenCalled();
    expect(result.reply).toMatch(/couldn't text Rohan/i);
    expect(result.reply).toContain("Walk the High Line.");
  });

  it("explains when Tiger knows the name but there is no iMessage handle", async () => {
    const result = await handlePlanInvite({
      spaceId: "dm-alan",
      senderId: "alan-id",
      senderName: "Alan",
      text: "make a plan with Keith",
      isGroup: false,
      contacts: [],
      tigerPeople: [{ displayName: "Keith", userId: "u-keith" }],
      buildPlan: async () => "Dinner at Jin Ramen.",
      sendInvite: async () => undefined,
    });
    expect(result.reply).toMatch(/in the directory/i);
    expect(result.reply).toMatch(/Keith/);
  });
});

describe("plan invite turn", () => {
  it("handles a 1:1 plan-with request before Gemini small talk", async () => {
    const replies: string[] = [];
    const outcome = await runConversationTurn(
      {
        spaceId: "dm-alan",
        senderId: "alan-id",
        senderName: "Alan",
        direction: "inbound",
        isGroup: false,
        question: "make a plan with Rohan tonight",
      },
      {
        reply: async (text) => {
          replies.push(text);
          return { id: "reply" };
        },
        responding: async (fn) => fn(),
      },
      {
        autoReply: true,
        handleTransport: async () => ({ handled: false, acknowledgement: "👍" }),
        suggest: async () => "should not run",
        transcript: () => [],
        recordAssistant: () => undefined,
        handlePlanInvite: async (input) =>
          handlePlanInvite({
            ...input,
            contacts: [{ displayName: "Rohan", photonSenderId: "rohan-id" }],
            buildPlan: async () => "Jazz at Lincoln Center at 8.",
            sendInvite: async () => undefined,
          }),
      },
    );
    expect(outcome).toBe("meetup");
    expect(replies[0]).toMatch(/Jazz at Lincoln Center/);
    expect(replies[0]).toMatch(/I texted Rohan an invite/i);
  });
});
