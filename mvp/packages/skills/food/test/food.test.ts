import { fakeFetch, fakeLlm, json, testContext } from "@mvp/core/testing";
import { describe, expect, it } from "vitest";
import { createFoodSkill, FoodInput } from "../src";

const origin = { label: "Columbia University", latitude: 40.8075, longitude: -73.9626 };
const place = (id: string, name: string, rating: number, openNow = true) => ({
  id,
  displayName: { text: name },
  formattedAddress: `${name} address`,
  location: { latitude: 40.81, longitude: -73.96 },
  priceLevel: "PRICE_LEVEL_MODERATE",
  rating,
  currentOpeningHours: { openNow },
  googleMapsUri: `https://maps.google.com/?cid=${id}`,
  primaryTypeDisplayName: { text: "Ramen restaurant" },
});
const input = (extra = {}) => FoodInput.parse({ origin, cuisine: ["ramen"], request: "cheap ramen", ...extra });

describe("food skill", () => {
  it("returns Places results with place ids and coordinates for routing", async () => {
    const fetch = fakeFetch(() => json({ places: [place("a", "Jin Ramen", 4.5), place("b", "Ramen Two", 4.1)] }));
    const result = await createFoodSkill({ apiKey: "k", fetch }).run(input(), testContext());
    expect(result.status).toBe("ok");
    expect(result.data[0]).toMatchObject({ id: "food:a", placeId: "a", name: "Jin Ramen" });
    expect(result.data[0]?.location.latitude).toBeTypeOf("number");
    expect(fetch.calls[0]?.body).toMatchObject({ textQuery: expect.stringContaining("ramen"), openNow: true });
  });

  it("maps a low budget to Places price levels", async () => {
    const fetch = fakeFetch(() => json({ places: [] }));
    await createFoodSkill({ apiKey: "k", fetch }).run(input({ budget: "low" }), testContext());
    expect(fetch.calls[0]?.body).toMatchObject({ priceLevels: ["PRICE_LEVEL_INEXPENSIVE"] });
  });

  it("reports an empty search as partial", async () => {
    const fetch = fakeFetch(() => json({ places: [] }));
    const result = await createFoodSkill({ apiKey: "k", fetch }).run(input(), testContext());
    expect(result).toMatchObject({ status: "partial", data: [] });
  });

  it("is unavailable when Places errors", async () => {
    const fetch = fakeFetch(() => json({ error: "quota" }, 429));
    const result = await createFoodSkill({ apiKey: "k", fetch }).run(input(), testContext());
    expect(result.status).toBe("unavailable");
  });

  it("is unavailable without a key and makes no request", async () => {
    const fetch = fakeFetch(() => json({}));
    const result = await createFoodSkill({ fetch }).run(input(), testContext());
    expect(result.status).toBe("unavailable");
    expect(fetch.calls).toHaveLength(0);
  });

  it("lets Gemini reorder candidates but ignores ids it invents", async () => {
    const fetch = fakeFetch(() => json({ places: [place("a", "A", 4.9), place("b", "B", 4.0), place("c", "C", 3.5)] }));
    const llm = fakeLlm({ rankFood: () => ({ orderedIds: ["food:c", "food:made-up", "food:b"] }) });
    const result = await createFoodSkill({ apiKey: "k", fetch, llm }).run(input(), testContext());
    expect(result.data.map((r) => r.id)).toEqual(["food:c", "food:b", "food:a"]);
  });

  it("keeps the default order when Gemini ranking fails", async () => {
    const fetch = fakeFetch(() => json({ places: [place("b", "B", 4.0), place("a", "A", 4.9)] }));
    const result = await createFoodSkill({ apiKey: "k", fetch, llm: fakeLlm({}) }).run(input(), testContext());
    expect(result.data.map((r) => r.id)).toEqual(["food:a", "food:b"]);
  });

  it("rejects input without an origin", () => {
    expect(FoodInput.safeParse({ cuisine: [] }).success).toBe(false);
  });
});
