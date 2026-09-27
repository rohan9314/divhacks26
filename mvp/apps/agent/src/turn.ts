import type { Location, Logger } from "@mvp/core";
import { type createTurnGraph, runTurn } from "@mvp/router";
import { type ChannelAdapter, type InboundMessage, mentionOf } from "./channel";
import type { ContextStore } from "./context-store";

/**
 * One batch of messages from one chat → at most one reply. Records shared locations first,
 * skips group chatter that doesn't mention the agent, and never lets an error reach the user
 * as silence: they get a short apology instead.
 */
export function createTurnHandler(deps: {
  graph: ReturnType<typeof createTurnGraph>;
  store: ContextStore;
  channel: ChannelAdapter;
  agentName: string;
  log: Logger;
  now?: () => Date;
}) {
  const mention = mentionOf(deps.agentName);
  return async (spaceId: string, batch: InboundMessage[]) => {
    const shared = batch.findLast((m) => m.location)?.location;
    if (shared) {
      const location: Location = { label: "your shared location", ...shared };
      await deps.store.recordLocation(spaceId, location);
    }

    const isGroup = batch.some((m) => m.isGroup);
    const lines = batch.map((m) => m.text.trim()).filter(Boolean);
    if (!lines.length) return; // only a location pin: remember it, say nothing

    let text = lines.join("\n");
    if (isGroup) {
      const invoked = lines.map(mention);
      if (!invoked.some((m) => m.mentioned)) {
        for (const line of lines) await deps.store.recordLine(spaceId, `friend: ${line}`);
        return;
      }
      text = invoked.map((m) => m.request).join("\n");
    }

    const context = await deps.store.get(spaceId);
    let reply: string;
    try {
      const result = await runTurn(deps.graph, {
        spaceId,
        text,
        now: deps.now?.() ?? new Date(),
        recent: context.recent,
        ...(context.lastLocation && { lastLocation: context.lastLocation }),
      });
      reply = result.reply;
      deps.log.info(
        {
          needs: result.state.intent?.needs,
          intentSource: result.state.intentSource,
          outcome: result.state.outcome,
          draft: result.state.draft?.source,
          rejected: result.state.draft?.rejected,
        },
        "turn complete",
      );
    } catch (error) {
      deps.log.error({ err: (error as Error).message }, "turn failed");
      reply = "Sorry, something went wrong on my end. Try again in a minute?";
    }
    await deps.channel.send(spaceId, reply);
    await deps.store.recordLine(spaceId, `user: ${text}`);
    await deps.store.recordLine(spaceId, `agent: ${reply.split("\n")[0]}`);
  };
}
