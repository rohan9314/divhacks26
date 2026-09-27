import { createInterface } from "node:readline";
import { parseLatLng } from "@mvp/core";
import type { ChannelAdapter } from "../channel";

/**
 * Local development and demo rehearsal, no Photon needed. Paste a Maps link or
 * "40.8075,-73.9626" to share a location. Prefix with "group:" to act like a group chat.
 */
export function createTerminalAdapter(options: { spaceId?: string } = {}): ChannelAdapter {
  const spaceId = options.spaceId ?? "terminal";
  let counter = 0;
  return {
    name: "terminal",
    async start(onMessage) {
      const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "you> " });
      console.log('Around Me (terminal). Share a location by pasting "40.8075,-73.9626" or a Maps link.');
      rl.prompt();
      rl.on("line", (raw) => {
        const isGroup = raw.startsWith("group:");
        const line = isGroup ? raw.slice(6).trim() : raw.trim();
        if (!line) return rl.prompt();
        const location = parseLatLng(line);
        onMessage({
          spaceId: isGroup ? `${spaceId}-group` : spaceId,
          messageId: `t-${++counter}`,
          text: location ? "" : line,
          ...(location && { location }),
          isGroup,
        });
        if (location) console.log("(location saved)");
      });
    },
    async send(_spaceId, text) {
      console.log(`\nagent> ${text.replace(/\n/g, "\n       ")}\n`);
      process.stdout.write("you> ");
    },
  };
}
