/**
 * Website accounts (plansaroundus.tech), moved from the DeepSpace backend
 * (backend/src/domain/site.ts) with the logic unchanged. Two-factor sign-in:
 *
 *   1. email a 6-digit code        2. trade it for a short-lived challenge
 *   3. show "Text CODE 123456 to @agent"; the person texts it from their phone
 *   4. the website polls until that text arrives → account + session token
 *
 * The phone step is reversed on purpose: an inbound text from the person
 * always reaches the bot (Photon allows it), while a bot's first text to an
 * unknown number may not. The agent's turn handler calls confirmPhoneText in
 * process; the sender's address is the proof of the number. Codes, challenges
 * and sessions are stored only as hashes.
 */

import { findAll, findOne, insert, patch, ServiceError, type Store, tryInsert } from "./store";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CHALLENGE_TTL_MS = 15 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 30 * 1000;
export const MAX_SENDS_PER_HOUR = 100;
export const MAX_ATTEMPTS = 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export type Budget = "free" | "low" | "medium" | "high";
export type VoiceReplies = "match" | "always" | "off";

export interface SitePreferences {
  name: string;
  homeNeighborhood?: string;
  dietary: string[];
  budget?: Budget;
  doesntDrink: boolean;
  voiceReplies: VoiceReplies;
}

export interface SiteUser {
  userId: string;
  phone: string;
  email: string;
  createdAt: string;
  onboardedAt?: string;
  preferences?: SitePreferences;
  xrplAddress?: string;
}

/** What the website sees: masked contact details, never the raw number or address. */
export interface PublicSiteUser {
  phone: string;
  email: string;
  onboarded: boolean;
  preferences: SitePreferences | null;
  wallet: { status: "none" } | { status: "ready"; xrplAddress: string };
}

export interface SiteDeps {
  store: Store;
  /** HMAC key for codes (SITE_AUTH_SECRET). */
  secret: string;
  maxUsers: number;
  sendEmailCode(email: string, code: string): Promise<void>;
  /**
   * The @agent number this person should text. On Photon's shared pool each
   * person gets their own (registering them with Photon if needed).
   */
  agentNumberFor?(phone: string): Promise<string | null>;
  /** Fallback single @agent number (AGENT_NUMBER) if Photon lookup isn't configured. */
  agentNumber?: string;
  /** Opens a 1:1 iMessage with this number and sends `body` (the channel adapter). */
  sendText?(phone: string, body: string): Promise<void>;
  now?: () => number;
}

/** "CODE 482913", "code: 482913" or just "482913" from the person's phone. */
export function parsePhoneCodeText(text: string): string | null {
  const match = /^\s*(?:code[:\s]*)?(\d{3})[\s-]?(\d{3})\s*$/i.exec(text);
  return match ? `${match[1]}${match[2]}` : null;
}

/** US numbers only for now: "(917) 782-4515" → "+19177824515". */
export function normalizeUsPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

export const maskPhone = (phone: string) => `+1 •••-•••-${phone.slice(-4)}`;
export const maskEmail = (email: string) => {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
};

const encoder = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

/** Stable website identity that never embeds the person's phone number. */
export async function siteUserId(phone: string): Promise<string> {
  return `site:${(await sha256Hex(`plans-around-us:user:${phone}`)).slice(0, 32)}`;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function randomToken(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sixDigits(): string {
  // Rejection sampling keeps every code equally likely.
  const limit = Math.floor(0xffffffff / 1_000_000) * 1_000_000;
  let n: number;
  do n = crypto.getRandomValues(new Uint32Array(1))[0]!;
  while (n >= limit);
  return String(n % 1_000_000).padStart(6, "0");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface CodeRow {
  key: string;
  hash: string;
  expiresAt: number;
  attempts: number;
  sends: unknown;
  verifiedAt?: number;
}

const BUDGETS = new Set<Budget>(["free", "low", "medium", "high"]);
const VOICE = new Set<VoiceReplies>(["match", "always", "off"]);

export function parsePreferences(input: unknown): SitePreferences | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 40) : "";
  if (!name) return null;
  const text = (value: unknown, max: number) =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
  const dietary = Array.isArray(raw.dietary)
    ? [
        ...new Set(
          raw.dietary
            .filter((d): d is string => typeof d === "string")
            .map((d) => d.trim().slice(0, 30))
            .filter(Boolean),
        ),
      ].slice(0, 10)
    : [];
  const budget = BUDGETS.has(raw.budget as Budget) ? (raw.budget as Budget) : undefined;
  const voiceReplies = VOICE.has(raw.voiceReplies as VoiceReplies) ? (raw.voiceReplies as VoiceReplies) : "match";
  const homeNeighborhood = text(raw.homeNeighborhood, 60);
  return {
    name,
    ...(homeNeighborhood && { homeNeighborhood }),
    dietary,
    ...(budget && { budget }),
    doesntDrink: raw.doesntDrink === true,
    voiceReplies,
  };
}

function readPreferences(value: unknown): SitePreferences | undefined {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  return parsePreferences(parsed) ?? undefined;
}

/** JSON columns can come back as a string or an already-parsed array. */
function numberArray(value: unknown): number[] {
  const parsed = typeof value === "string" ? safeJson(value) : value;
  return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function publicUser(user: SiteUser): PublicSiteUser {
  return {
    phone: maskPhone(user.phone),
    email: maskEmail(user.email),
    onboarded: Boolean(user.onboardedAt),
    preferences: user.preferences ?? null,
    wallet: user.xrplAddress ? { status: "ready", xrplAddress: user.xrplAddress } : { status: "none" },
  };
}

export function createSite(deps: SiteDeps) {
  const { store } = deps;
  const now = deps.now ?? Date.now;

  async function userRow(phone: string) {
    const row = await findOne<SiteUser & { preferences?: unknown }>(store, "site_users", { phone });
    if (!row) return null;
    const userId = row.data.userId || (await siteUserId(phone));
    if (!row.data.userId) await patch(store, "site_users", row.recordId, { userId });
    return {
      recordId: row.recordId,
      user: { ...row.data, userId, preferences: readPreferences(row.data.preferences) } as SiteUser,
    };
  }

  async function userCount(): Promise<number> {
    return (await findAll(store, "site_users", {}, 1000)).length;
  }

  /** Issue and deliver a code under `key`, with a resend cooldown and an hourly cap. */
  async function issueCode(key: string, deliver: (code: string) => Promise<void>): Promise<string> {
    const t = now();
    const existing = await findOne<CodeRow>(store, "site_codes", { key });
    const recent = numberArray(existing?.data.sends)
      .filter((at) => t - at < HOUR)
      .sort((a, b) => a - b);
    if (recent.length >= MAX_SENDS_PER_HOUR) throw new ServiceError("rate_limited", "Too many codes. Try again later.");
    if (recent.length && t - recent[recent.length - 1]! < RESEND_COOLDOWN_MS) {
      throw new ServiceError("rate_limited", "Wait a moment before asking for another code.");
    }
    const code = sixDigits();
    const data = {
      key,
      hash: await hmacHex(deps.secret, `${key}:${code}`),
      expiresAt: t + CODE_TTL_MS,
      attempts: 0,
      sends: [...recent, t],
      verifiedAt: 0,
    };
    const recordId = existing ? existing.recordId : await insert(store, "site_codes", data);
    if (existing) await patch(store, "site_codes", recordId, data);
    try {
      await deliver(code);
    } catch {
      // A send that never arrived shouldn't count toward the cooldown or hourly cap.
      await patch(store, "site_codes", recordId, { hash: "", expiresAt: 0, sends: recent });
      throw new ServiceError("send_failed", "Couldn't send the code. Try again.");
    }
    return code;
  }

  /** Check and consume a code. */
  async function checkCode(key: string, rawCode: unknown): Promise<void> {
    const code = typeof rawCode === "string" ? rawCode.replace(/\D/g, "") : "";
    const pending = await findOne<CodeRow>(store, "site_codes", { key });
    if (!pending || !pending.data.hash) throw new ServiceError("no_code", "Ask for a code first.");
    if (now() > Number(pending.data.expiresAt))
      throw new ServiceError("expired", "That code expired. Ask for a new one.");
    const attempts = Number(pending.data.attempts ?? 0);
    if (attempts >= MAX_ATTEMPTS) throw new ServiceError("too_many_attempts", "Too many tries. Ask for a new code.");
    const expected = await hmacHex(deps.secret, `${key}:${code}`);
    if (code.length !== 6 || !constantTimeEqual(expected, pending.data.hash)) {
      await patch(store, "site_codes", pending.recordId, { attempts: attempts + 1 });
      if (attempts + 1 >= MAX_ATTEMPTS)
        throw new ServiceError("too_many_attempts", "Too many tries. Ask for a new code.");
      throw new ServiceError("wrong_code", "That code isn't right.");
    }
    // Keep the send history for rate limiting; clear the code so it can't be reused.
    await patch(store, "site_codes", pending.recordId, { hash: "", attempts: 0, expiresAt: 0 });
  }

  async function challengeEmail(challenge: unknown): Promise<{ email: string; recordId: string } | null> {
    if (typeof challenge !== "string" || !challenge) return null;
    const row = await findOne<{ email: string; expiresAt: number }>(store, "site_challenges", {
      tokenHash: await sha256Hex(challenge),
    });
    return row && Number(row.data.expiresAt) >= now() ? { email: row.data.email, recordId: row.recordId } : null;
  }

  /** The email and phone must be new, or already belong to the same account. */
  async function pairingError(email: string, phone: string): Promise<"account_mismatch" | "full" | null> {
    const byPhone = await userRow(phone);
    const byEmail = await findOne<SiteUser>(store, "site_users", { email });
    if (byPhone && byPhone.user.email !== email) return "account_mismatch";
    if (byEmail && byEmail.data.phone !== phone) return "account_mismatch";
    if (!byPhone && (await userCount()) >= deps.maxUsers) return "full";
    return null;
  }

  async function assertPairing(email: string, phone: string) {
    const error = await pairingError(email, phone);
    if (error === "full") throw new ServiceError("full", "The beta is full.");
    if (error) throw new ServiceError("account_mismatch", "That email and number belong to different accounts.");
  }

  return {
    async stats() {
      return { spotsTaken: Math.min(await userCount(), deps.maxUsers), spotsTotal: deps.maxUsers };
    },

    /** Step 1: email a code. */
    async startEmail(rawEmail: unknown): Promise<{ ok: true }> {
      const email = normalizeEmail(rawEmail);
      if (!email) throw new ServiceError("invalid_email", "Enter a valid email.");
      await issueCode(`email:${email}`, (code) => deps.sendEmailCode(email, code));
      return { ok: true };
    },

    /** Step 2: trade the emailed code for a challenge token. */
    async verifyEmail(rawEmail: unknown, rawCode: unknown): Promise<{ challenge: string }> {
      const email = normalizeEmail(rawEmail);
      if (!email) throw new ServiceError("invalid_email", "Enter a valid email.");
      await checkCode(`email:${email}`, rawCode);
      const challenge = randomToken();
      await insert(store, "site_challenges", {
        tokenHash: await sha256Hex(challenge),
        email,
        expiresAt: now() + CHALLENGE_TTL_MS,
      });
      return { challenge };
    },

    /**
     * Step 3: a code for the person to text to @agent from this number.
     * Nothing is sent from here; see confirmPhoneText.
     */
    async startPhone(
      challenge: unknown,
      rawPhone: unknown,
    ): Promise<{ ok: true; code: string; agentNumber: string | null }> {
      const phone = normalizeUsPhone(rawPhone);
      if (!phone) throw new ServiceError("invalid_phone", "Enter a US mobile number.");
      const verified = await challengeEmail(challenge);
      if (!verified) throw new ServiceError("challenge_expired", "Start again with your email.");
      await assertPairing(verified.email, phone);
      // Their own @agent number first: without it they have nobody to text.
      let agentNumber = deps.agentNumber || null;
      if (deps.agentNumberFor) {
        try {
          agentNumber = (await deps.agentNumberFor(phone)) ?? agentNumber;
        } catch {
          if (!agentNumber)
            throw new ServiceError("number_unavailable", "Couldn't set up @agent for this number. Try again.");
        }
      }
      if (!agentNumber)
        throw new ServiceError("number_unavailable", "Couldn't set up @agent for this number. Try again.");
      const code = await issueCode(`phone:${phone}`, async () => {});
      return { ok: true, code, agentNumber };
    },

    /**
     * An inbound iMessage, relayed by the agent. Returns the bot's reply when
     * the text is a sign-in code, or null when it's an ordinary message.
     * The sender's address proves the number; the code ties it to the sign-in.
     */
    async confirmPhoneText(externalId: string, text: string): Promise<string | null> {
      const code = parsePhoneCodeText(text);
      if (!code) return null;
      const phone = normalizeUsPhone(externalId);
      if (!phone) {
        return "Text the code from the phone number you entered on the website (not an email address).";
      }
      const pending = await findOne<CodeRow>(store, "site_codes", { key: `phone:${phone}` });
      if (!pending?.data.hash) {
        return "I don't see a sign-in waiting for this number. Start again at plansaroundus.tech/signin.";
      }
      if (now() > Number(pending.data.expiresAt)) {
        return "That code expired. Go back to the website for a new one.";
      }
      const attempts = Number(pending.data.attempts ?? 0);
      if (attempts >= MAX_ATTEMPTS) return "Too many tries. Go back to the website for a new code.";
      const expected = await hmacHex(deps.secret, `phone:${phone}:${code}`);
      if (!constantTimeEqual(expected, pending.data.hash)) {
        await patch(store, "site_codes", pending.recordId, { attempts: attempts + 1 });
        return "That code doesn't match. Check the one on the website and try again.";
      }
      await patch(store, "site_codes", pending.recordId, { hash: "", verifiedAt: now() });
      return "You're verified! Head back to plansaroundus.tech, it'll finish signing you in. I'm @agent. Text me here any time you want to plan something.";
    },

    /**
     * Step 4: the website polls this. `{ pending: true }` until the person's
     * text arrives, then creates the account if new and starts a session.
     */
    async verifyPhone(
      challenge: unknown,
      rawPhone: unknown,
    ): Promise<{ pending: true } | { token: string; user: PublicSiteUser }> {
      const phone = normalizeUsPhone(rawPhone);
      if (!phone) throw new ServiceError("invalid_phone", "Enter a US mobile number.");
      const verified = await challengeEmail(challenge);
      if (!verified) throw new ServiceError("challenge_expired", "Start again with your email.");
      const pending = await findOne<CodeRow>(store, "site_codes", { key: `phone:${phone}` });
      const at = Number(pending?.data.verifiedAt ?? 0);
      if (!pending || !at) {
        if (!pending || now() > Number(pending.data.expiresAt)) {
          throw new ServiceError("expired", "That code expired. Get a new one.");
        }
        return { pending: true };
      }
      if (now() - at > CODE_TTL_MS) throw new ServiceError("expired", "That code expired. Get a new one.");
      // Re-checked: someone may have taken the last spot since the code was shown.
      await assertPairing(verified.email, phone);
      // One sign-in per text.
      await patch(store, "site_codes", pending.recordId, { verifiedAt: 0, expiresAt: 0 });
      await patch(store, "site_challenges", verified.recordId, { expiresAt: 0 });
      let row = await userRow(phone);
      if (!row) {
        await tryInsert(store, "site_users", {
          userId: await siteUserId(phone),
          phone,
          email: verified.email,
          createdAt: new Date(now()).toISOString(),
        });
        row = await userRow(phone);
      }
      if (!row) throw new ServiceError("server_error", "Could not create the account.");
      const token = randomToken();
      await insert(store, "site_sessions", {
        tokenHash: await sha256Hex(token),
        phone,
        expiresAt: now() + SESSION_TTL_MS,
      });
      return { token, user: publicUser(row.user) };
    },

    /** The signed-in user for a bearer token, or null. */
    async session(token: string | undefined): Promise<SiteUser | null> {
      if (!token) return null;
      const found = await findOne<{ phone: string; expiresAt: number }>(store, "site_sessions", {
        tokenHash: await sha256Hex(token),
      });
      if (!found || Number(found.data.expiresAt) < now()) return null;
      return (await userRow(found.data.phone))?.user ?? null;
    },

    async signOut(token: string): Promise<void> {
      const found = await findOne(store, "site_sessions", { tokenHash: await sha256Hex(token) });
      if (found) await patch(store, "site_sessions", found.recordId, { expiresAt: 0 });
    },

    async savePreferences(phone: string, input: unknown): Promise<SitePreferences> {
      const prefs = parsePreferences(input);
      if (!prefs) throw new ServiceError("invalid_preferences", "Add your first name.");
      const row = await userRow(phone);
      if (!row) throw new ServiceError("unauthorized", "Sign in again.");
      await patch(store, "site_users", row.recordId, {
        preferences: prefs,
        onboardedAt: row.user.onboardedAt ?? new Date(now()).toISOString(),
      });
      return prefs;
    },

    /** Send the "say hi" iMessage that opens the chat with the agent. */
    async startChat(user: SiteUser): Promise<void> {
      if (!deps.sendText) throw new ServiceError("send_failed", "Couldn't reach iMessage right now.");
      const name = user.preferences?.name;
      try {
        await deps.sendText(
          user.phone,
          `Hi${name ? ` ${name}` : ""}! This is @agent from plansaroundus. Add me to a group chat and mention @agent when you need a plan.`,
        );
      } catch {
        throw new ServiceError("send_failed", "Couldn't send the hello text. Try again.");
      }
    },

    /** Removes the account and ends every session for it. */
    async deleteUser(phone: string): Promise<void> {
      const row = await userRow(phone);
      if (row) await store.remove("site_users", row.recordId);
      for (const session of await findAll(store, "site_sessions", { phone })) {
        await patch(store, "site_sessions", session.recordId, { expiresAt: 0 });
      }
    },

    /** Waitlist for when all spots are taken. Requires a verified email. */
    async joinWaitlist(challenge: unknown, rawPhone: unknown, rawName: unknown): Promise<{ position: number }> {
      const verified = await challengeEmail(challenge);
      if (!verified) throw new ServiceError("challenge_expired", "Start again with your email.");
      const phone = normalizeUsPhone(rawPhone) ?? undefined;
      const name = typeof rawName === "string" ? rawName.trim().slice(0, 60) : undefined;
      await tryInsert(store, "site_waitlist", {
        email: verified.email,
        ...(phone && { phone }),
        ...(name && { name }),
        at: new Date(now()).toISOString(),
      });
      const all = await findAll<{ email: string; at: string }>(store, "site_waitlist", {}, 1000);
      all.sort((a, b) => a.data.at.localeCompare(b.data.at));
      return { position: all.findIndex((row) => row.data.email === verified.email) + 1 };
    },
  };
}

export type Site = ReturnType<typeof createSite>;
