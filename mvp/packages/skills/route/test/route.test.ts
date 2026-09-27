import { fakeFetch, json, testContext } from "@mvp/core/testing";
import { describe, expect, it } from "vitest";
import { createRouteSkill, RouteInput } from "../src";

const input = RouteInput.parse({
  origin: { label: "Columbia", latitude: 40.8075, longitude: -73.9626 },
  destination: { label: "Riverside Park", latitude: 40.8013, longitude: -73.9713 },
  travelMode: "WALK",
});

describe("route skill", () => {
  it("returns the Routes duration and a Maps directions link", async () => {
    const fetch = fakeFetch(() => json({ routes: [{ duration: "722s", distanceMeters: 1000 }] }));
    const result = await createRouteSkill({ apiKey: "k", fetch }).run(input, testContext());
    expect(result.status).toBe("ok");
    expect(result.data).toMatchObject({ durationMinutes: 12, mode: "WALK", destinationLabel: "Riverside Park" });
    expect(result.data.directionsUrl).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&.*travelmode=walk/);
  });

  it("returns a link and no duration when Routes finds nothing", async () => {
    const fetch = fakeFetch(() => json({ routes: [] }));
    const result = await createRouteSkill({ apiKey: "k", fetch }).run(input, testContext());
    expect(result.status).toBe("partial");
    expect(result.data.durationMinutes).toBeUndefined();
    expect(result.data.directionsUrl).toContain("google.com/maps/dir");
  });

  it("returns a link and no duration when Routes errors", async () => {
    const fetch = fakeFetch(() => json({}, 500));
    const result = await createRouteSkill({ apiKey: "k", fetch }).run(input, testContext());
    expect(result.status).toBe("partial");
    expect(result.data.durationMinutes).toBeUndefined();
  });

  it("returns a link without calling Routes when no key is set", async () => {
    const fetch = fakeFetch(() => json({}));
    const result = await createRouteSkill({ fetch }).run(input, testContext());
    expect(result.status).toBe("partial");
    expect(fetch.calls).toHaveLength(0);
  });

  it("sends a departure time only for transit", async () => {
    const fetch = fakeFetch(() => json({ routes: [{ duration: "900s" }] }));
    const skill = createRouteSkill({ apiKey: "k", fetch });
    await skill.run({ ...input, departureTime: "2026-09-27T00:00:00Z" }, testContext());
    await skill.run({ ...input, travelMode: "TRANSIT", departureTime: "2026-09-27T00:00:00Z" }, testContext());
    expect(fetch.calls[0]?.body).not.toHaveProperty("departureTime");
    expect(fetch.calls[1]?.body).toHaveProperty("departureTime");
  });

  it("rejects an unknown travel mode", () => {
    expect(RouteInput.safeParse({ ...input, travelMode: "TELEPORT" }).success).toBe(false);
  });
});
