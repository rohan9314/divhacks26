import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SKILLS = join(__dirname, "../../skills");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("skill isolation", () => {
  it("skills import only @mvp/core, zod and node built-ins", () => {
    const offenders = sources(SKILLS).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)]
        .map((m) => m[1] as string)
        .filter((spec) => !/^(@mvp\/core(\/testing)?|zod|vitest|node:.*|\.\.?\/.*)$/.test(spec))
        .map((spec) => `${file.slice(SKILLS.length)} imports ${spec}`),
    );
    expect(offenders).toEqual([]);
  });

  it("skills never read process.env", () => {
    const offenders = sources(SKILLS).filter((file) => readFileSync(file, "utf8").includes("process.env"));
    expect(offenders).toEqual([]);
  });
});
