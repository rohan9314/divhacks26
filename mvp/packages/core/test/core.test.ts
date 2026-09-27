import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, loadConfig, parseLatLng, requestedHour, timeWindow, toGeminiSchema, UserIntent } from "../src";

const NOW = new Date("2026-09-26T23:00:00Z"); // Sat 7 PM EDT

describe("parseLatLng", () => {
  it("reads Apple Maps and Google Maps links", () => {
    expect(parseLatLng("https://maps.apple.com/?ll=40.8075,-73.9626&q=Pin")).toEqual({
      latitude: 40.8075,
      longitude: -73.9626,
    });
    expect(parseLatLng("https://www.google.com/maps/@40.7359,-73.9911,15z")).toEqual({
      latitude: 40.7359,
      longitude: -73.9911,
    });
  });

  it("ignores coordinates outside NYC", () => {
    expect(parseLatLng("https://maps.apple.com/?ll=37.77,-122.41")).toBeNull();
  });
});

describe("time", () => {
  it("reads an explicit hour and defaults to the current NYC hour", () => {
    expect(requestedHour("at 9pm", NOW)).toBe(21);
    expect(requestedHour("now", NOW)).toBe(19);
  });

  it("builds a tonight window from now until 2 AM", () => {
    expect(timeWindow("tonight", NOW)).toEqual({
      from: "2026-09-26T23:00:00.000Z",
      to: "2026-09-27T06:00:00.000Z",
    });
  });

  it("builds a tomorrow window in New York time", () => {
    expect(timeWindow("tomorrow", NOW).from).toBe("2026-09-27T12:00:00.000Z");
  });
});

describe("config", () => {
  it("runs the terminal channel with nothing configured", () => {
    expect(loadConfig({}).CHAT_PROVIDER).toBe("terminal");
  });

  it("refuses to start the live channel half-configured", () => {
    expect(() => loadConfig({ CHAT_PROVIDER: "photon", GEMINI_API_KEY: "x" })).toThrow(
      /GOOGLE_MAPS_API_KEY is required/,
    );
  });
});

describe("logger", () => {
  it("redacts sender ids, text and coordinates", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    createLogger({ destination: sink }).info(
      { senderId: "+19175550123", text: "meet me at home", origin: { latitude: 40.8, longitude: -73.9 } },
      "turn",
    );
    expect(lines.join("")).not.toMatch(/9175550123|meet me|40\.8/);
  });
});

describe("Gemini schema", () => {
  it("exports the intent schema without a $schema marker", () => {
    const schema = toGeminiSchema(UserIntent) as Record<string, unknown>;
    expect(schema).not.toHaveProperty("$schema");
    expect(schema).toMatchObject({ type: "object", required: expect.arrayContaining(["needs", "when"]) });
  });
});
