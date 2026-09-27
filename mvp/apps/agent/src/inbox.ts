import type { InboundMessage } from "./channel";

/**
 * Collects messages per chat and hands them over after a short pause, so "dinner?" + a shared
 * location + "somewhere cheap" becomes one turn. Drops redelivered message ids.
 */
export function createInbox(options: {
  delayMs: number;
  process: (spaceId: string, batch: InboundMessage[]) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const pending = new Map<string, { batch: InboundMessage[]; timer: NodeJS.Timeout }>();
  const seen = new Set<string>();
  const running = new Map<string, Promise<void>>();

  const flush = (spaceId: string) => {
    const entry = pending.get(spaceId);
    if (!entry) return;
    pending.delete(spaceId);
    // One turn at a time per chat, in arrival order.
    const previous = running.get(spaceId) ?? Promise.resolve();
    const next = previous.then(() => options.process(spaceId, entry.batch)).catch(options.onError);
    running.set(spaceId, next);
    void next.finally(() => {
      if (running.get(spaceId) === next) running.delete(spaceId);
    });
  };

  return {
    push(message: InboundMessage) {
      if (seen.has(message.messageId)) return;
      seen.add(message.messageId);
      if (seen.size > 5_000) seen.delete(seen.values().next().value as string);
      const entry = pending.get(message.spaceId);
      if (entry) clearTimeout(entry.timer);
      const batch = [...(entry?.batch ?? []), message];
      pending.set(message.spaceId, { batch, timer: setTimeout(() => flush(message.spaceId), options.delayMs) });
    },
    /** Resolves when nothing is pending or running (tests, shutdown). */
    async drain() {
      while (pending.size || running.size) {
        for (const spaceId of [...pending.keys()]) flush(spaceId);
        await Promise.all(running.values());
      }
    },
  };
}
