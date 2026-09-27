import "dotenv/config";
import { createServer } from "node:http";
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
import { createTurnHandler } from "./turn";

const config = loadConfig();
const log = createLogger({ level: config.CHAT_PROVIDER === "terminal" ? "warn" : config.LOG_LEVEL });

// Every credential is read here, once, and handed to the component that needs it.
const pool = config.DATABASE_URL ? createPool(config.DATABASE_URL) : undefined;
const query = pool ? queryFrom(pool) : undefined;
const llm = config.GEMINI_API_KEY
  ? createGeminiLlm({ apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL })
  : undefined;
const mapsKey = config.GOOGLE_MAPS_API_KEY;

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

const channel =
  config.CHAT_PROVIDER === "photon"
    ? createPhotonAdapter({
        projectId: config.PHOTON_PROJECT_ID as string,
        projectSecret: config.PHOTON_PROJECT_SECRET as string,
      })
    : createTerminalAdapter();

// Chat memory lives in Tiger when it's configured and the app schema exists (mvp/sql/001).
const memory = createMemoryContextStore();
const tableReady = query ? await hasChatContextTable(query).catch(() => false) : false;
if (query && !tableReady)
  console.warn("app.chat_context is missing (apply mvp/sql/001); chat memory stays in process.");
const store =
  query && tableReady
    ? withFallback(createPgContextStore(query), memory, (error) =>
        log.warn({ err: (error as Error).message }, "chat context store failed; using memory"),
      )
    : memory;

const handle = createTurnHandler({ graph, store, channel, agentName: config.AGENT_NAME, log });
const inbox = createInbox({
  delayMs: config.CHAT_PROVIDER === "terminal" ? 0 : config.MESSAGE_BATCH_DELAY_MS,
  process: handle,
  onError: (error) => log.error({ err: (error as Error).message }, "inbound batch failed"),
});

const missing = [
  !llm && "GEMINI_API_KEY (keyword parsing + template replies)",
  !mapsKey && "GOOGLE_MAPS_API_KEY (no food, geocoding or travel times)",
  !query && "DATABASE_URL (no safety or events; chat memory in process)",
].filter(Boolean);
if (missing.length) console.warn(`Running without: ${missing.join("; ")}`);

if (config.CHAT_PROVIDER === "photon") {
  // Liveness for Docker/Caddy. Reports the build, never configuration values.
  createServer((req, res) => {
    if (req.url !== "/healthz") return void res.writeHead(404).end();
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ status: "ok", version: config.GIT_SHA, channel: channel.name }));
  }).listen(config.HEALTH_PORT);
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
