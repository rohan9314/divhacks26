import "dotenv/config";
import { serve } from "@hono/node-server";
import { assignedAgentNumber, createPgStore, createResendSender, createSite } from "@mvp/accounts";
import { createGeminiLlm, createLogger, createPlacesGeocoder, createPool, loadConfig, queryFrom } from "@mvp/core";
import { createTurnGraph } from "@mvp/router";
import { createEventsSkill } from "@mvp/skill-events";
import { createFoodSkill } from "@mvp/skill-food";
import { createRouteSkill } from "@mvp/skill-route";
import { createSafetySkill } from "@mvp/skill-safety";
import { createPhotonAdapter } from "./adapters/photon";
import { createTerminalAdapter } from "./adapters/terminal";
import { createMemoryContextStore, createPgContextStore, hasChatContextTable, withFallback } from "./context-store";
import { createInbox } from "./inbox";
import { createSiteApi, type IntegrationStatus } from "./site-api";
import { createTurnHandler } from "./turn";

const config = loadConfig();
const terminal = config.CHAT_PROVIDER === "terminal";
const log = createLogger({ level: terminal ? "warn" : config.LOG_LEVEL });

// Every credential is read here, once, and handed to the component that needs it.
const pool = config.DATABASE_URL ? createPool(config.DATABASE_URL) : undefined;
const query = pool ? queryFrom(pool) : undefined;
const llm = config.GEMINI_API_KEY
  ? createGeminiLlm({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL })
  : undefined;
const mapsKey = config.GOOGLE_MAPS_API_KEY;
const photon =
  config.PHOTON_PROJECT_ID && config.PHOTON_PROJECT_SECRET
    ? { projectId: config.PHOTON_PROJECT_ID, secret: config.PHOTON_PROJECT_SECRET, lineType: config.PHOTON_LINE_TYPE }
    : undefined;

const graph = createTurnGraph({
  skills: {
    safety: createSafetySkill({ query }),
    events: createEventsSkill({ query }),
    food: createFoodSkill({ apiKey: mapsKey, llm }),
    route: createRouteSkill({ apiKey: mapsKey }),
  },
  llm,
  ...(mapsKey && { geocode: createPlacesGeocoder({ apiKey: mapsKey }) }),
  log,
});

const channel = terminal
  ? createTerminalAdapter({ ...(config.TERMINAL_PHONE && { senderAddress: config.TERMINAL_PHONE }) })
  : createPhotonAdapter({
      projectId: config.PHOTON_PROJECT_ID as string,
      projectSecret: config.PHOTON_PROJECT_SECRET as string,
    });

// Chat memory lives in Tiger when it's configured and the app schema exists (mvp/sql/001).
const memory = createMemoryContextStore();
const tableReady = query ? await hasChatContextTable(query).catch(() => false) : false;
if (query && !tableReady)
  console.warn("app.chat_context is missing (npm run db:migrate); chat memory stays in process.");
const store =
  query && tableReady
    ? withFallback(createPgContextStore(query), memory, (error) =>
        log.warn({ err: (error as Error).message }, "chat context store failed; using memory"),
      )
    : memory;

// Website accounts, moved off DeepSpace: records in Tiger (mvp/sql/002), email through Resend,
// each person's own @agent number from Photon's shared pool.
const sendEmail = config.RESEND_API_KEY
  ? createResendSender({ apiKey: config.RESEND_API_KEY, from: config.EMAIL_FROM })
  : terminal
    ? // Local testing only: the email is printed instead of sent.
      async (message: { to: string; subject: string; text: string }) =>
        void console.warn(`\n[email to ${message.to}] ${message.subject}\n`)
    : async () => {
        throw new Error("RESEND_API_KEY is not set");
      };
const agentNumberFor = async (phone: string) =>
  (photon ? await assignedAgentNumber(photon, phone) : null) ?? config.AGENT_NUMBER ?? null;
const site =
  config.SITE_AUTH_SECRET && query
    ? createSite({
        store: createPgStore(query),
        secret: config.SITE_AUTH_SECRET,
        maxUsers: config.BETA_MAX_USERS,
        ...(config.AGENT_NUMBER && { agentNumber: config.AGENT_NUMBER }),
        ...(photon && { agentNumberFor: (phone: string) => assignedAgentNumber(photon, phone) }),
        ...(channel.sendTo && { sendText: channel.sendTo }),
        sendEmailCode: (email, code) =>
          sendEmail({
            to: email,
            subject: `${code} is your plansaroundus code`,
            text: `Your plansaroundus verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't try to sign in, you can ignore this email.`,
          }),
      })
    : null;

const handle = createTurnHandler({
  graph,
  store,
  channel,
  agentName: config.AGENT_NAME,
  log,
  ...(site && { confirmSignIn: (sender: string, text: string) => site.confirmPhoneText(sender, text) }),
});
const inbox = createInbox({
  delayMs: terminal ? 0 : config.MESSAGE_BATCH_DELAY_MS,
  process: handle,
  onError: (error) => log.error({ err: (error as Error).message }, "inbound batch failed"),
});

const status = (configured: boolean): IntegrationStatus["status"] => (configured ? "UNVERIFIED" : "NOT_CONFIGURED");
const api = createSiteApi({
  site,
  agentNumberFor,
  sendEmail,
  allowedOrigins: config.WEB_ALLOWED_ORIGINS,
  log,
  // Configured-or-not only; nothing here makes a live call, so nothing claims LIVE.
  integrations: () => [
    { id: "photon", label: "iMessage (Photon)", status: status(Boolean(photon)), detail: "Chat channel" },
    { id: "gemini", label: "Gemini", status: status(Boolean(llm)), detail: "Intent parsing and replies" },
    { id: "google", label: "Google Maps", status: status(Boolean(mapsKey)), detail: "Restaurants and routes" },
    { id: "tiger", label: "Tiger Data", status: status(Boolean(query)), detail: "NYPD history, events, accounts" },
    { id: "email", label: "Email (Resend)", status: status(Boolean(config.RESEND_API_KEY)), detail: "Sign-in codes" },
  ],
  // Booleans and the build only, never values, so a deploy can be checked from outside.
  health: () => ({
    status: "ok",
    version: config.GIT_SHA,
    channel: channel.name,
    site: Boolean(site),
    photon: Boolean(photon),
    email: config.RESEND_API_KEY ? "resend" : null,
    chatMemory: tableReady ? "tiger" : "memory",
  }),
});

const missing = [
  !llm && "GEMINI_API_KEY (keyword parsing + template replies)",
  !mapsKey && "GOOGLE_MAPS_API_KEY (no food, geocoding or travel times)",
  !query && "DATABASE_URL (no safety, events or accounts; chat memory in process)",
  !config.SITE_AUTH_SECRET && "SITE_AUTH_SECRET (website sign-in off)",
  config.SITE_AUTH_SECRET &&
    !config.RESEND_API_KEY &&
    (terminal ? "RESEND_API_KEY (sign-in emails print here)" : "RESEND_API_KEY (sign-in emails fail)"),
].filter(Boolean);
if (missing.length) console.warn(`Running without: ${missing.join("; ")}`);

// The website API and /healthz. In terminal mode only when sign-in is being tested locally.
if (!terminal || site) {
  serve({ fetch: api.fetch, port: config.HTTP_PORT, hostname: "0.0.0.0" });
  if (terminal) console.warn(`Website API on http://localhost:${config.HTTP_PORT}`);
}

await channel.start((message) => inbox.push(message));
log.info({ channel: channel.name, version: config.GIT_SHA }, "agent started");

const shutdown = async () => {
  await inbox.drain();
  await pool?.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
