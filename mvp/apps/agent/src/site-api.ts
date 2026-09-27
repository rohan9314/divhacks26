import { publicUser, ServiceError, type Site, type SiteUser } from "@mvp/accounts";
import type { Logger } from "@mvp/core";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";

/**
 * The website's API (plansaroundus.tech on Vercel), moved from DeepSpace's /api/site/* to /api/*
 * on the droplet. Same paths below /api, same response shapes and error codes, so the site only
 * needs VITE_AGENT_API_URL pointed at the new host.
 */

const MAX_BODY_BYTES = 16 * 1024;

const STATUS: Record<string, 400 | 401 | 404 | 409 | 429 | 502 | 503> = {
  rate_limited: 429,
  too_many_attempts: 429,
  send_failed: 502,
  email_failed: 502,
  full: 409,
  account_mismatch: 409,
  challenge_expired: 401,
  unauthorized: 401,
  not_found: 404,
  want_wallet_required: 400,
  wallet_unavailable: 503,
  site_unconfigured: 503,
  number_unavailable: 503,
  dashboard_unavailable: 503,
};

export interface IntegrationStatus {
  id: string;
  label: string;
  status: "LIVE" | "NOT_CONFIGURED" | "ERROR" | "MOCK" | "UNVERIFIED";
  detail: string;
}

export interface SiteApiDeps {
  /** Null when SITE_AUTH_SECRET is unset: every account route answers site_unconfigured. */
  site: Site | null;
  /** This person's @agent number (their own on Photon's shared pool), for the "email me my number" button. */
  agentNumberFor(phone: string): Promise<string | null>;
  sendEmail(message: { to: string; subject: string; text: string }): Promise<void>;
  integrations(): IntegrationStatus[];
  health(): Record<string, unknown>;
  allowedOrigins: string[];
  log: Logger;
}

type Handler = (c: Context) => Promise<unknown>;

async function readJson(c: Context): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) throw new ServiceError("too_large", "Request too large.");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new ServiceError("invalid_json", "Invalid JSON.");
  }
}

const bearer = (c: Context) => /^Bearer (.+)$/.exec(c.req.header("Authorization") ?? "")?.[1];

export function createSiteApi(deps: SiteApiDeps): Hono {
  const app = new Hono();

  const site = (): Site => {
    if (!deps.site) throw new ServiceError("site_unconfigured", "Set SITE_AUTH_SECRET for the website.");
    return deps.site;
  };

  /** ServiceErrors become `{ error: code }` with the site's status codes; anything else is a 500. */
  const handle = (fn: Handler) => async (c: Context) => {
    try {
      const body = await fn(c);
      c.header("Cache-Control", "no-store");
      return c.json(body as object);
    } catch (error) {
      if (error instanceof ServiceError) return c.json({ error: error.code }, STATUS[error.code] ?? 400);
      deps.log.error({ route: `${c.req.method} ${c.req.path}`, err: (error as Error).name }, "site api failed");
      return c.json({ error: "server_error" }, 500);
    }
  };

  const signedIn = (fn: (c: Context, user: SiteUser, token: string) => Promise<unknown>) =>
    handle(async (c) => {
      const token = bearer(c);
      const user = token ? await site().session(token) : null;
      if (!user || !token) throw new ServiceError("unauthorized", "Sign in again.");
      return fn(c, user, token);
    });

  app.get("/healthz", (c) => c.json(deps.health()));

  // Bearer tokens, no cookies. Only the website's origins may call from a browser.
  app.use(
    "/api/*",
    cors({
      origin: deps.allowedOrigins.includes("*") ? "*" : deps.allowedOrigins,
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      maxAge: 600,
    }),
  );

  app.get(
    "/api/stats",
    handle(() => site().stats()),
  );
  app.get(
    "/api/integrations",
    handle(async () => ({ checkedAt: null, integrations: deps.integrations() })),
  );
  // The XRPL dashboard is not part of the MVP; the site shows its "unavailable" state.
  app.get(
    "/api/xrpl/dashboard",
    handle(async () => {
      throw new ServiceError("dashboard_unavailable", "Not part of this version.");
    }),
  );

  app.post(
    "/api/auth/email/start",
    handle(async (c) => site().startEmail((await readJson(c)).email)),
  );
  app.post(
    "/api/auth/email/verify",
    handle(async (c) => {
      const body = await readJson(c);
      return site().verifyEmail(body.email, body.code);
    }),
  );
  app.post(
    "/api/auth/phone/start",
    handle(async (c) => {
      const body = await readJson(c);
      return site().startPhone(body.challenge, body.phone);
    }),
  );
  app.post(
    "/api/auth/phone/verify",
    handle(async (c) => {
      const body = await readJson(c);
      // Polled by the website until the person texts the code to @agent.
      return site().verifyPhone(body.challenge, body.phone);
    }),
  );
  app.post(
    "/api/waitlist",
    handle(async (c) => {
      const body = await readJson(c);
      return site().joinWaitlist(body.challenge, body.phone, body.name);
    }),
  );

  app.post(
    "/api/auth/signout",
    signedIn(async (_c, _user, token) => {
      await site().signOut(token);
      return { ok: true };
    }),
  );
  app.get(
    "/api/me",
    signedIn(async (_c, user) => publicUser(user)),
  );
  app.put(
    "/api/me/preferences",
    signedIn(async (c, user) => {
      await site().savePreferences(user.phone, await readJson(c));
      return { ok: true };
    }),
  );
  app.post(
    "/api/me/start-chat",
    signedIn(async (_c, user) => {
      await site().startChat(user);
      return { ok: true };
    }),
  );
  app.post(
    "/api/me/send-number",
    signedIn(async (_c, user) => {
      const number = await deps.agentNumberFor(user.phone).catch(() => null);
      if (!number) throw new ServiceError("email_failed", "Couldn't look up your @agent number. Try again.");
      const name = user.preferences?.name;
      await deps
        .sendEmail({
          to: user.email,
          subject: "Your @agent's number",
          text: `Hi${name ? ` ${name}` : ""},\n\nText @agent at ${number}, or add that number to a group chat and mention @agent.\n\n— plansaroundus`,
        })
        .catch(() => {
          throw new ServiceError("email_failed", "Couldn't send the email.");
        });
      return { ok: true };
    }),
  );
  // Memories, plan evidence and wallets are not part of the MVP; the site shows empty states.
  app.get(
    "/api/me/memories",
    signedIn(async () => ({ memories: [] })),
  );
  app.delete(
    "/api/me/memories/:id",
    signedIn(async () => {
      throw new ServiceError("not_found", "Not found.");
    }),
  );
  app.get(
    "/api/me/evidence",
    signedIn(async () => ({ plans: [] })),
  );
  app.post(
    "/api/me/wallet",
    signedIn(async () => {
      throw new ServiceError("wallet_unavailable", "Wallets are not part of this version.");
    }),
  );
  app.delete(
    "/api/me",
    signedIn(async (_c, user) => {
      await site().deleteUser(user.phone);
      return { ok: true };
    }),
  );

  return app;
}
