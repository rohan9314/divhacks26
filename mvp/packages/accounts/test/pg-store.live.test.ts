import { createPool, queryFrom } from "@mvp/core";
import { config } from "dotenv";
import { afterAll, describe, expect, it } from "vitest";
import { createPgStore } from "../src/pg-store";
import { createSite, normalizeUsPhone } from "../src/site";

// Opt-in: runs the real sign-up flow against Tiger (after `npm run db:migrate`).
//   MVP_PG_LIVE=1 DOTENV_CONFIG_PATH=../.env npx vitest run packages/accounts/test/pg-store.live.test.ts
// Uses a reserved test domain and a 555 number, and deletes every row it wrote.
config({ path: process.env.DOTENV_CONFIG_PATH ?? ".env", quiet: true });
const live = process.env.MVP_PG_LIVE === "1" && Boolean(process.env.DATABASE_URL);

const EMAIL = `pg-${Date.now()}@pgtest.invalid`;
const PHONE = "(917) 555-0199";

describe.skipIf(!live)("accounts on Tiger (live)", () => {
  const pool = createPool(process.env.DATABASE_URL ?? "");
  const query = queryFrom(pool);
  const store = createPgStore(query);

  afterAll(async () => {
    await pool.query(
      "DELETE FROM app.records WHERE collection LIKE 'site_%' AND (data::text LIKE '%pgtest.invalid%' OR data::text LIKE '%+19175550199%')",
    );
    await pool.end();
  });

  it("round-trips records with merge updates and equality queries", async () => {
    const created = await store.create("site_waitlist", { email: EMAIL, at: new Date().toISOString(), n: 1 });
    if (!created.success) throw new Error(created.error);
    await store.update("site_waitlist", created.data.recordId, { n: 2, name: "Test" });
    const found = await store.query<{ n: number; name: string }>("site_waitlist", { where: { email: EMAIL } });
    expect(found.success && found.data.records[0]?.data).toMatchObject({ n: 2, name: "Test" });
  });

  it("enforces the unique indexes like DeepSpace's uniqueOn", async () => {
    const again = await store.create("site_waitlist", { email: EMAIL, at: new Date().toISOString() });
    expect(again).toMatchObject({ success: false, code: "unique_violation" });
  });

  it("runs the whole sign-up on Postgres", async () => {
    let emailed = "";
    const site = createSite({
      store,
      secret: "live-test-secret-live-test-secret",
      maxUsers: 100_000,
      agentNumber: "+15555550100",
      sendEmailCode: async (_email, code) => {
        emailed = code;
      },
    });
    await site.startEmail(EMAIL);
    const { challenge } = await site.verifyEmail(EMAIL, emailed);
    const { code } = await site.startPhone(challenge, PHONE);
    expect(await site.verifyPhone(challenge, PHONE)).toEqual({ pending: true });
    expect(await site.confirmPhoneText(normalizeUsPhone(PHONE) as string, `CODE ${code}`)).toMatch(/verified/);
    const done = await site.verifyPhone(challenge, PHONE);
    if (!("token" in done)) throw new Error("still pending");
    const user = await site.session(done.token);
    expect(user?.email).toBe(EMAIL);
    await site.savePreferences(user?.phone as string, { name: "Test", dietary: [] });
    expect((await site.session(done.token))?.preferences?.name).toBe("Test");
    await site.deleteUser(user?.phone as string);
    expect(await site.session(done.token)).toBeNull();
  });
});
