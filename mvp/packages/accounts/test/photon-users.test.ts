import { describe, expect, it, vi } from "vitest";
import { assignedAgentNumber } from "../src/photon-users";

const creds = { projectId: "proj", secret: "sec" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("assignedAgentNumber", () => {
  it("returns an existing user's own assigned number without creating anyone", async () => {
    const fetchImpl = vi.fn(async () =>
      json({ succeed: true, data: [{ phoneNumber: "+19175550101", assignedPhoneNumber: "+14155550001" }] }),
    );
    await expect(assignedAgentNumber(creds, "+19175550101", { fetchImpl })).resolves.toBe("+14155550001");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://spectrum.photon.codes/projects/proj/users/");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa("proj:sec")}`);
  });

  it("registers a new phone and returns the number Photon assigns it", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ succeed: true, data: [] }))
      .mockResolvedValueOnce(
        json({ succeed: true, data: { phoneNumber: "+19175550102", assignedPhoneNumber: "+14155550002" } }),
      );
    await expect(assignedAgentNumber(creds, "+19175550102", { fetchImpl })).resolves.toBe("+14155550002");
    const [, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe("POST");
    // Photon's API rejects a create without `type` (422 VALIDATION_ERROR).
    expect(JSON.parse(String(init.body))).toEqual({
      type: "shared",
      phoneNumber: "+19175550102",
      firstName: "plansaroundus",
    });
  });

  it("reads the number back when assignment lags creation", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ succeed: true, data: [] }))
      .mockResolvedValueOnce(json({ succeed: true, data: { phoneNumber: "+19175550103" } }))
      .mockResolvedValueOnce(
        json({ succeed: true, data: [{ phoneNumber: "+19175550103", assignedPhoneNumber: "+14155550003" }] }),
      );
    await expect(assignedAgentNumber(creds, "+19175550103", { fetchImpl })).resolves.toBe("+14155550003");
  });

  it("surfaces Photon errors", async () => {
    const fetchImpl = vi.fn(async () => json({ succeed: false, message: "nope" }, 401));
    await expect(assignedAgentNumber(creds, "+19175550104", { fetchImpl })).rejects.toThrow(/401/);
  });
});
