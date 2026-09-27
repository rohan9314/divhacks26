import { fakeQuery, testContext } from "@mvp/core/testing";
import { describe, expect, it } from "vitest";
import { createEventsSkill, EventsInput } from "../src";

const input = EventsInput.parse({
  origin: { label: "Columbia University", latitude: 40.8075, longitude: -73.9626 },
  from: "2026-09-26T21:00:00.000Z",
  to: "2026-09-27T06:00:00.000Z",
});

const row = (id: string, title: string, overrides = {}) => ({
  source: "nyc_parks",
  source_id: id,
  title,
  description: "Bring a blanket.",
  category: "film",
  starts_at: "2026-09-26T23:30:00Z",
  ends_at: null,
  venue: "Riverside Park",
  latitude: "40.8013",
  longitude: "-73.9713",
  source_url: `https://www.nycgovparks.org/events/${id}`,
  registration_url: null,
  updated_at: "2026-09-26T10:00:00Z",
  distance_meters: "1003.4",
  ...overrides,
});

describe("events skill", () => {
  it("normalizes official rows into recommendations with stable ids", async () => {
    const query = fakeQuery(() => [row("1", "Outdoor Movie Night")]);
    const result = await createEventsSkill({ query }).run(input, testContext());
    expect(result.status).toBe("ok");
    expect(result.data[0]).toMatchObject({
      id: "event:nyc_parks:1",
      name: "Outdoor Movie Night",
      distanceMeters: 1003,
      location: { label: "Riverside Park", latitude: 40.8013 },
      url: "https://www.nycgovparks.org/events/1",
    });
    expect(result.sources.map((s) => s.url)).toContain("https://data.cityofnewyork.us/d/w3wp-dpdi");
  });

  it("dedupes the same event listed by both feeds and caps results at five", async () => {
    const rows = [
      row("1", "Outdoor Movie Night"),
      row("p-9", "Outdoor movie night!", { source: "nyc_permits" }),
      ...["2", "3", "4", "5", "6", "7"].map((id) => row(id, `Event ${id}`)),
    ];
    const result = await createEventsSkill({ query: fakeQuery(() => rows) }).run(input, testContext());
    expect(result.data).toHaveLength(5);
    expect(result.data.filter((e) => /movie/i.test(e.name))).toHaveLength(1);
  });

  it("passes the window, radius and categories to the query", async () => {
    const query = fakeQuery(() => []);
    await createEventsSkill({ query }).run({ ...input, categories: ["music"] }, testContext());
    expect(query.calls[0]?.values).toEqual([40.8075, -73.9626, input.from, input.to, 2000, ["music"]]);
  });

  it("looks once more at 5 km when nothing is within the radius", async () => {
    const query = fakeQuery((_sql, values) =>
      values[4] === 5000 ? [row("9", "Harlem Run", { distance_meters: "4200" })] : [],
    );
    const result = await createEventsSkill({ query }).run(input, testContext());
    expect(query.calls.map((c) => c.values[4])).toEqual([2000, 5000]);
    expect(result.data[0]?.name).toBe("Harlem Run");
  });

  it("decodes HTML entities from the Parks feed", async () => {
    const query = fakeQuery(() => [
      row("1", "Yoga en Espa&#241;ol &amp; more", { venue: "Poor Richard&#39;s Playground" }),
    ]);
    const result = await createEventsSkill({ query }).run(input, testContext());
    expect(result.data[0]).toMatchObject({
      name: "Yoga en Español & more",
      location: { label: "Poor Richard's Playground" },
    });
  });

  it("reports no matches as partial", async () => {
    const result = await createEventsSkill({ query: fakeQuery(() => []) }).run(input, testContext());
    expect(result).toMatchObject({ status: "partial", data: [] });
  });

  it("is unavailable when the query fails", async () => {
    const query = fakeQuery(() => {
      throw new Error("timeout");
    });
    expect((await createEventsSkill({ query }).run(input, testContext())).status).toBe("unavailable");
  });

  it("rejects a window that isn't ISO time", () => {
    expect(EventsInput.safeParse({ ...input, from: "tonight" }).success).toBe(false);
  });
});
