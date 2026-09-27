/**
 * Photon (Spectrum) users for website sign-ups.
 *
 * On Photon's shared-pool plans each person is routed through their own
 * number from the pool (`assignedPhoneNumber`), and a line only messages
 * people registered as users of the project. So during sign-up we register
 * the person's phone (or find them if they already exist) and show them the
 * number assigned to them: that's the @agent number they text.
 *
 * Management API: https://spectrum.photon.codes, HTTP Basic with the project
 * id and secret (PHOTON_PROJECT_ID / PHOTON_PROJECT_SECRET).
 */

const API = "https://spectrum.photon.codes";

interface PhotonUser {
  id?: string;
  phoneNumber?: string | null;
  assignedPhoneNumber?: string | null;
}

export interface PhotonCredentials {
  projectId: string;
  secret: string;
  /** Line type for new users; Photon rejects creates without it (422). Default "shared". */
  lineType?: "shared" | "dedicated";
}

function listFrom(body: unknown): PhotonUser[] {
  const data = (body as { data?: unknown })?.data;
  if (Array.isArray(data)) return data as PhotonUser[];
  const users = (data as { users?: unknown })?.users;
  return Array.isArray(users) ? (users as PhotonUser[]) : [];
}

function userFrom(body: unknown): PhotonUser | null {
  const data = (body as { data?: unknown })?.data;
  if (!data || typeof data !== "object") return null;
  const nested = (data as { user?: unknown }).user;
  return (nested && typeof nested === "object" ? nested : data) as PhotonUser;
}

/**
 * The @agent number assigned to this phone, registering the phone as a
 * Photon user first if needed. Null when Photon doesn't return one.
 */
export async function assignedAgentNumber(
  creds: PhotonCredentials,
  phone: string,
  options: { firstName?: string; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = `${API}/projects/${encodeURIComponent(creds.projectId)}/users/`;
  const headers = {
    Authorization: `Basic ${btoa(`${creds.projectId}:${creds.secret}`)}`,
    "Content-Type": "application/json",
  };
  const find = async (): Promise<PhotonUser | undefined> => {
    const res = await fetchImpl(base, { headers });
    if (!res.ok) throw new Error(`photon users list failed (${res.status})`);
    return listFrom(await res.json()).find((u) => u.phoneNumber === phone);
  };

  const existing = await find();
  if (existing?.assignedPhoneNumber) return existing.assignedPhoneNumber;

  if (!existing) {
    const res = await fetchImpl(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: creds.lineType ?? "shared",
        phoneNumber: phone,
        firstName: options.firstName || "plansaroundus",
      }),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`photon user create failed (${res.status}): ${detail}`);
    }
    const created = userFrom(await res.json());
    if (created?.assignedPhoneNumber) return created.assignedPhoneNumber;
  }
  // Assignment can lag creation by a moment; read it back once.
  return (await find())?.assignedPhoneNumber ?? null;
}
