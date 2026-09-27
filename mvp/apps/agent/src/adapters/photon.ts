import { parseLatLng } from "@mvp/core";
import { type Message, type Space, Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import type { ChannelAdapter, InboundMessage } from "../channel";

/** Text plus any location the message carries (typed link, rich link, or iMessage location vCard). */
async function readContent(
  message: Message,
): Promise<{ text: string; location?: { latitude: number; longitude: number } }> {
  const content = message.content;
  switch (content.type) {
    case "text": {
      const location = parseLatLng(content.text);
      return { text: content.text, ...(location && { location }) };
    }
    case "richlink": {
      const location = parseLatLng(content.url);
      return location ? { text: "", location } : { text: content.url };
    }
    case "attachment": {
      const isVcard = /vcard|vlocation/i.test(content.mimeType) || content.name.toLowerCase().endsWith(".vcf");
      if (isVcard && (content.size ?? 0) < 64_000) {
        const location = parseLatLng((await content.read()).toString("utf8"));
        if (location) return { text: "", location };
      }
      return { text: "" };
    }
    default:
      return { text: "" };
  }
}

const SENTINELS = new Set(["someone", "any", "shared", "unknown", ""]);
const usable = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length >= 8 && !SENTINELS.has(value.trim().toLowerCase());

/**
 * Who sent this, as a phone or Apple ID. The project credentials identify the agent's line, not the
 * person, so use the sender id, then the sender address, then the other party of a 1:1 chat id.
 */
export function senderAddressOf(message: Pick<Message, "sender">, spaceId: string): string | undefined {
  const sender = message.sender as { id?: unknown; address?: unknown; kind?: unknown } | undefined;
  if (sender?.kind === "agent") return undefined;
  if (usable(sender?.id)) return sender.id.trim();
  if (usable(sender?.address)) return sender.address.trim();
  const peer = spaceId.includes(";-;") ? spaceId.split(";-;").pop()?.trim() : undefined;
  return usable(peer) ? peer : undefined;
}

/** Photon Spectrum iMessage. The only component that sends user-visible messages in production. */
export function createPhotonAdapter(options: { projectId: string; projectSecret: string }): ChannelAdapter {
  const spaces = new Map<string, Space>();
  let app: Awaited<ReturnType<typeof Spectrum>> | undefined;
  return {
    name: "photon",
    async start(onMessage) {
      app = await Spectrum({
        projectId: options.projectId,
        projectSecret: options.projectSecret,
        providers: [imessage.config()],
      });
      const messages = app.messages;
      void (async () => {
        for await (const [space, message] of messages) {
          if (message.direction !== "inbound" || message.sender?.kind === "agent") continue;
          spaces.set(space.id, space);
          const { text, location } = await readContent(message);
          if (!text && !location) continue;
          const senderAddress = senderAddressOf(message, space.id);
          const inbound: InboundMessage = {
            spaceId: space.id,
            messageId: message.id,
            text,
            ...(location && { location }),
            isGroup: (space as { type?: string }).type === "group",
            ...(senderAddress && { senderAddress }),
          };
          onMessage(inbound);
        }
      })();
    },
    async send(spaceId, text) {
      const space = spaces.get(spaceId);
      if (!space) throw new Error("unknown chat");
      await space.send(text);
    },
    async sendTo(phone, text) {
      if (!app) throw new Error("photon is not connected");
      // biome-ignore lint/suspicious/noExplicitAny: the provider helper takes the app; its type isn't exported.
      const space = await imessage(app as any).space.create(phone);
      spaces.set(space.id, space);
      await space.send(text);
    },
  };
}
