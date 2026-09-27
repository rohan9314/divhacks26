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

/** Photon Spectrum iMessage. The only component that sends user-visible messages in production. */
export function createPhotonAdapter(options: { projectId: string; projectSecret: string }): ChannelAdapter {
  const spaces = new Map<string, Space>();
  return {
    name: "photon",
    async start(onMessage) {
      const app = await Spectrum({
        projectId: options.projectId,
        projectSecret: options.projectSecret,
        providers: [imessage.config()],
      });
      void (async () => {
        for await (const [space, message] of app.messages) {
          if (message.direction !== "inbound" || message.sender?.kind === "agent") continue;
          spaces.set(space.id, space);
          const { text, location } = await readContent(message);
          if (!text && !location) continue;
          const inbound: InboundMessage = {
            spaceId: space.id,
            messageId: message.id,
            text,
            ...(location && { location }),
            isGroup: (space as { type?: string }).type === "group",
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
  };
}
