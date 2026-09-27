const ZONE = "America/New_York";

/** Wall-clock parts in New York for a given instant. */
export function nycParts(now: Date): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

/** The instant at a New York wall-clock time on the same NYC calendar day as `now`, plus `dayOffset`. */
function nycAt(now: Date, dayOffset: number, hour: number): Date {
  const { year, month, day } = nycParts(now);
  const guess = Date.UTC(year, month - 1, day + dayOffset, hour, 0);
  // Shift by the zone offset at that instant (EST/EDT); one correction is enough away from DST edges.
  const p = nycParts(new Date(guess));
  const offsetMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - guess;
  return new Date(guess - offsetMs);
}

/** The hour the user asked about ("at 9pm", "tonight"), else the current NYC hour. */
export function requestedHour(when: string, now: Date): number {
  const match = when.match(/\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/i);
  if (match?.[1] && match[2]) return (Number(match[1]) % 12) + (/pm/i.test(match[2]) ? 12 : 0);
  const current = nycParts(now).hour;
  if (/tonight|evening/i.test(when)) return Math.max(current, 20);
  if (/morning/i.test(when)) return 9;
  if (/afternoon/i.test(when)) return 14;
  return current;
}

/** A search window for events: [from, to] as ISO strings. */
export function timeWindow(when: string, now: Date): { from: string; to: string } {
  const tomorrow = /tomorrow/i.test(when);
  const dayOffset = tomorrow ? 1 : 0;
  if (/tonight|evening/i.test(when) || (tomorrow && /night|evening/i.test(when))) {
    const start = tomorrow ? nycAt(now, 1, 17) : new Date(Math.max(now.getTime(), nycAt(now, 0, 17).getTime()));
    return { from: start.toISOString(), to: nycAt(now, dayOffset + 1, 2).toISOString() };
  }
  if (tomorrow) return { from: nycAt(now, 1, 8).toISOString(), to: nycAt(now, 2, 2).toISOString() };
  if (/weekend/i.test(when)) {
    return { from: now.toISOString(), to: new Date(now.getTime() + 3 * 86_400_000).toISOString() };
  }
  const hour = requestedHour(when, now);
  if (hour !== nycParts(now).hour) {
    const start = nycAt(now, hour < nycParts(now).hour ? 1 : 0, hour);
    return { from: start.toISOString(), to: new Date(start.getTime() + 4 * 3_600_000).toISOString() };
  }
  return { from: now.toISOString(), to: new Date(now.getTime() + 6 * 3_600_000).toISOString() };
}

export function formatHour(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}
