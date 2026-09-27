import { describe, expect, it, vi } from "vitest";
import { runConversationTurn } from "../src/agent/turn.js";
import { formatRelayGuest, handleRelay, isRelayRequest, parseRelayRequest } from "../src/chat/relay.js";

describe("relay parsing", () => {
  it("reads a named Photon text request", () => {
    expect(parseRelayRequest("text Rohan that we're at Columbia")).toEqual({
      names: ["Rohan"],
      body: "we're at Columbia",
    });
    expect(parseRelayRequest("can you message Keith: running 10 min late")).toEqual({
      names: ["Keith"],
      body: "running 10 min late",
    });
    expect(parseRelayRequest("tell Rohan and Alan we're going to Jin Ramen")).toEqual({
      names: ["Rohan", "Alan"],
      body: "we're going to Jin Ramen",
    });
    expect(parseRelayRequest("send Rohan a text that the table is ready")).toEqual({
      names: ["Rohan"],
      body: "the table is ready",
    });
    expect(parseRelayRequest("ask Keith to meet at 116th")).toEqual({
      names: ["Keith"],
      body: "meet at 116th",
    });
    expect(isRelayRequest("text Rohan")).toBe(true);
  });

  it("does not steal dinner, payments, or tell-me questions", () => {
    expect(isRelayRequest("tell me a good dinner spot")).toBe(false);
    expect(isRelayRequest("send Rohan $20")).toBe(false);
    expect(isRelayRequest("what should we do tonight?")).toBe(false);
    expect(isRelayRequest("make a plan with Rohan")).toBe(false);
  });
});

describe("relay send", () => {
  it("texts the person over Photon and acks the host", async () => {
    const sendMessage = vi.fn(async (_to: string, _body: string) => undefined);
    const result = await handleRelay({
      text: "text Rohan that we're at Katz's",
      senderId: "alan-id",
      senderName: "Alan",
      contacts: [{ displayName: "Rohan", photonSenderId: "rohan-id" }],
      sendMessage,
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/I texted Rohan/i);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0]).toBe("rohan-id");
    expect(sendMessage.mock.calls[0]?.[1]).toBe(formatRelayGuest("Alan", "we're at Katz's"));
  });

  it("does not claim a send when they have no Photon id", async () => {
    const sendMessage = vi.fn(async (_to: string, _body: string) => undefined);
    const result = await handleRelay({
      text: "message Keith we're downstairs",
      senderId: "alan-id",
      senderName: "Alan",
      contacts: [],
      tigerPeople: [{ displayName: "Keith", userId: "u-keith" }],
      sendMessage,
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(result.reply).toMatch(/hasn't texted this iMessage number/i);
  });

  it("still texts Rohan when Keith is in Tiger without a Photon id", async () => {
    const sendMessage = vi.fn(async (_to: string, _body: string) => undefined);
    const result = await handleRelay({
      text: "text Rohan that the table is ready",
      senderId: "alan-id",
      senderName: "Alan",
      contacts: [
        { displayName: "Alan", photonSenderId: "alan-id" },
        { displayName: "Rohan", photonSenderId: "rohan-id" },
      ],
      tigerPeople: [
        { displayName: "Rohan", userId: "photon:rohan-id" },
        { displayName: "Keith", userId: "site:keith" },
      ],
      sendMessage,
    });

    expect(result.handled).toBe(true);
    expect(result.reply).toMatch(/I texted Rohan/i);
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0]?.[0]).toBe("rohan-id");
  });
});

describe("relay turn", () => {
  it("sends before Gemini replies", async () => {
    const replies: string[] = [];
    const sendMessage = vi.fn(async (_to: string, _body: string) => undefined);
    const outcome = await runConversationTurn(
      {
        spaceId: "dm-alan",
        senderId: "alan-id",
        senderName: "Alan",
        direction: "inbound",
        isGroup: false,
        question: "text Rohan that the concert is at 8",
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
        handleRelay: async (input) =>
          handleRelay({
            ...input,
            contacts: [{ displayName: "Rohan", photonSenderId: "rohan-id" }],
            sendMessage,
          }),
      },
    );
    expect(outcome).toBe("relay");
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(replies[0]).toMatch(/I texted Rohan/i);
  });
});
