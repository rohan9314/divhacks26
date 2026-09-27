import { fakeQuery, testContext } from "@mvp/core/testing";
import { describe, expect, it } from "vitest";
import { createSafetySkill, SafetyInput } from "../src";

const input = SafetyInput.parse({
  origin: { label: "Columbia University", latitude: 40.8075, longitude: -73.9626 },
  hourEt: 19,
});

const report = (overrides = {}) => ({
  report: {
    total: 2400,
    byHour: { "16": 160, "19": 80, "3": 20 },
    top: [
      { offense: "PETIT LARCENY", count: 600 },
      { offense: "HARASSMENT 2", count: 300 },
    ],
    first: "2024-09-27T00:00:00Z",
    last: "2026-06-30T12:00:00Z",
    ...overrides,
  },
});

describe("safety skill", () => {
  it("returns counts, hour comparison, categories and the data date", async () => {
    const query = fakeQuery(() => [report()]);
    const result = await createSafetySkill({ query }).run(input, testContext());
    expect(result.status).toBe("ok");
    expect(result.data).toMatchObject({
      areaCount: 2400,
      hourCount: 80,
      typicalHourCount: 100,
      peakHour: 16,
      dataThrough: "2026-06-30",
      topCategories: [{ offense: "PETIT LARCENY", count: 600 }, expect.anything()],
    });
    expect(result.warnings.join(" ")).toMatch(/not live/i);
    expect(query.calls[0]?.values).toEqual([40.8075, -73.9626, 800]);
  });

  it("never returns a safe/unsafe verdict", async () => {
    const result = await createSafetySkill({ query: fakeQuery(() => [report()]) }).run(input, testContext());
    expect(JSON.stringify(result.data)).not.toMatch(/\b(safe|unsafe|dangerous|score)\b/i);
  });

  it("reports no nearby data as partial", async () => {
    const query = fakeQuery(() => [report({ total: 0, byHour: {}, top: [], first: null, last: null })]);
    const result = await createSafetySkill({ query }).run(input, testContext());
    expect(result).toMatchObject({ status: "partial", data: null });
  });

  it("is unavailable when the query fails", async () => {
    const query = fakeQuery(() => {
      throw new Error("connection refused");
    });
    const result = await createSafetySkill({ query }).run(input, testContext());
    expect(result.status).toBe("unavailable");
  });

  it("is unavailable without a database", async () => {
    const result = await createSafetySkill({}).run(input, testContext());
    expect(result.status).toBe("unavailable");
  });

  it("rejects an out-of-range hour", () => {
    expect(SafetyInput.safeParse({ ...input, hourEt: 24 }).success).toBe(false);
  });
});
