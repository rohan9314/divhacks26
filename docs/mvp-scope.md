# MVP scope: "Around Me" core workflow

Branch: `mvp` (local, branched from `main` at `b0bc549`). Owner: Keith (integration).

## Goal

One text with a shared location produces **one** reply containing:

1. a real restaurant or event,
2. sourced safety context,
3. a real travel duration,
4. a working Google Maps link.

Nothing else ships on this branch until that works live.

## Status (2026-09-27)

| Ticket | State |
|---|---|
| 1 Workspace, CI job | Done (npm workspaces, Biome, `mvp` job in `deployment-ci.yml`; Docker build first runs in CI) |
| 2 `core` | Done |
| 3 Router skeleton + terminal adapter | Done |
| 4–7 Skills ported with contract tests | Done (owners should review their package) |
| 8 `parseIntent` + routing tests | Done (fake-Gemini tests; live Gemini checked manually) |
| 9 `compose` + `check` | Done |
| 10 Photon adapter + `app.chat_context` | Code done; **not yet run against Photon**. Migration applied to Tiger 2026-09-27 (`npm run db:migrate`); memory verified across restarts |
| 11 Deploy | `mvp/Dockerfile` + `mvp/compose.yaml` written; not deployed |
| 12 Demo rehearsal | Blocked on a Google Maps key and Photon credentials |
| 0 Hour-one checks | Gemini structured output ✓ and Tiger ✓ (live terminal run). Maps key, Photon and group chat not yet checked. |

Found during the live run:
- `city_events` holds NYC Parks only (486 events in the next 7 days, mostly daytime). The permitted-events feed (`tvpp-9vvx`) has never been ingested.
- Parks titles carry HTML entities; the events skill now decodes them.

Deviations from the plan below:
- **npm workspaces instead of pnpm** (pnpm isn't installed). Skill isolation is enforced by `router/test/boundaries.test.ts` instead of by pnpm's strict dependencies.
- **Injected `fetch`/`query` fakes instead of msw.** Same coverage, less setup.
- **An extra `resolveLocations` node.** Missing-location clarification is decided in code after geocoding, not by Gemini.
- **Event radius widens once, 2 km → 5 km**, when nothing is nearby.
- **Safety drops the shooting/collision/streetlight layers.** It needs only `nypd_complaints`, per CLAUDE.md.

## Approach

- Build the MVP as a **new, self-contained pnpm workspace in `mvp/`**. Leave `src/` untouched on this branch as a reference. Deleting old code is a separate step after the MVP passes its acceptance checks.
- **Port, don't rewrite,** the four skills that already call real APIs:
  - `src/skills/{safety,food,events,route}Skill.ts`
  - `src/safety.ts`
  - `src/skills/geo.ts`
  - `src/domain/contracts.ts`
- **Reuse the existing Tiger tables and ingestion** as-is: `nypd_complaints`, `city_events`, `sql/001–004`, `scripts/ingest_*.py`, `Dockerfile.ingest`. Porting ingestion to TypeScript is not MVP work.
- **Orchestration uses LangGraph** (`@langchain/langgraph`) for the fixed graph only:
  - no LangChain agents and no model-chosen tool calls;
  - Gemini is called with `@google/genai` directly inside two nodes, using structured output;
  - skills never import LangGraph.

## Layout

```text
mvp/
  package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.workspace.ts
  apps/agent/            channel adapters, bootstrap, /healthz
  packages/core/         zod contracts, config (validated env), Gemini client, db pool, logger
  packages/router/       LangGraph turn graph: loadContext → parseIntent → runSkill* → route → compose → check
  packages/skills/safety   (Alan)
  packages/skills/events   (events owner)
  packages/skills/food     (Keith)
  packages/skills/route    (Rohan)
  sql/                   only new MVP tables (app.chat_context)
```

Each skill package depends only on `@mvp/core`. A test in `router` fails if any skill imports `@mvp/router` or `@langchain/*`.

## Contracts (packages/core)

The existing types from `src/domain/contracts.ts` become zod schemas. The MVP drops the non-MVP fields (`conversational`, `invitees`).

```ts
type SkillName = "safety" | "food" | "events" | "route";

interface Skill<I, O> {
  name: SkillName;
  input: z.ZodType<I>;
  timeoutMs: number;
  run(input: I, ctx: SkillContext): Promise<SkillResult<O>>;
}

interface SkillContext {
  now: Date;
  fetch: typeof fetch;   // injectable for msw / tests
  db?: Pool;             // safety, events only
  log: Logger;
}
```

Every `Recommendation` keeps a stable `id` (`food:<placeId>`, `event:<source>:<sourceId>`). The composer may only cite these IDs.

## The turn graph (packages/router)

| Node | Does | Gemini? |
|---|---|---|
| `loadContext` | Last shared location for the chat, last ~10 messages | no |
| `parseIntent` | Text + context → `UserIntent` (zod → JSON schema, structured output). No location → `needsClarification`. | yes |
| `clarify` | One question, no tools, END | no |
| `runSkill` (fan-out via `Send`) | Runs only `intent.needs` minus `route`, in parallel. Validates input, enforces `timeoutMs`, and turns throws/timeouts into `status: "unavailable"`. | no |
| `route` | If food/events returned results, routes origin → top pick. Otherwise, or if only route was asked, routes to `intent.destination`. | no |
| `compose` | Structured output `{ text, citedIds[] }` from skill data only; max 3 recommendations; safety as a one-line note unless asked | yes |
| `check` | Every `citedId` and every URL in `text` must come from skill results, else fall back to a template reply built from the results. Discloses any unavailable skill. | no |

Sending happens in `apps/agent`, never inside the graph.

## Channel adapters (apps/agent)

```ts
interface ChannelAdapter {
  start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void>;
  send(spaceId: string, text: string): Promise<void>;
}
```

- **`terminal`**: local development and demo rehearsal. Must work with no Photon credentials.
- **`photon`**: Spectrum iMessage, 1:1 chats. Records shared locations into `app.chat_context`. Group chat depends on the messaging-provider decision (see open decisions); the adapter interface is what makes swapping cheap.
- Per-chat 2 s debounce and in-memory dedupe on message ID. One agent instance only. A job queue (pg-boss) is **not** MVP.

## Storage

- Reuse: `nypd_complaints`, `city_events` (Tiger).
- New: `app.chat_context(space_id text pk, last_lat, last_lng, last_label, location_at timestamptz, recent jsonb, updated_at)`.
  - No phone numbers stored; `space_id` is Photon's chat ID.
  - Nothing from `app.*` is written to analytics tables.

## Environment (the whole list)

`GEMINI_API_KEY`, `GEMINI_MODEL`, `GOOGLE_MAPS_API_KEY`, `DATABASE_URL`, `CHAT_PROVIDER` (`terminal`|`photon`), `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `AGENT_NAME`, `TIMEZONE`. Optional: `TAVILY_API_KEY`.

These are validated at startup by one zod schema. A missing required key refuses to start, with a clear message.

## Work breakdown

| # | Ticket | Owner | Depends on | Done when |
|---|---|---|---|---|
| 0 | Hour-one checks: Gemini structured output on the chosen model, Places + Routes calls, Tiger connect, Photon 1:1 send/receive, **agent in a group with an unregistered member** | Keith + all | none | Results written in this doc |
| 1 | Workspace scaffold: pnpm, TS, vitest, Biome, CI job for `mvp/` (typecheck + test) | Keith | none | `pnpm -C mvp test` green in CI |
| 2 | `core`: zod contracts, config, Gemini client (timeout, retry, fake), pg pool, pino with redaction | Keith | 1 | Unit tests pass |
| 3 | `router` skeleton: graph with stub skills, terminal adapter end to end | Keith | 2 | Terminal: text → stub reply |
| 4 | `skills/safety`: port `safetySkill` + `safety.ts`; counts, hour comparison, top categories, source timestamp; no safe/unsafe score | Alan | 2 | Contract tests pass |
| 5 | `skills/events`: port official `city_events` path; drop the free-text Gemini merge (ungrounded); max 5, ordered by time fit, distance, category | Events owner | 2 | Contract tests pass |
| 6 | `skills/food`: port Places Text Search; drop Gemini-Maps fallback; Gemini re-rank over returned IDs with deterministic fallback | Keith | 2 | Contract tests pass |
| 7 | `skills/route`: port Routes API; WALK + TRANSIT first; on failure, Maps URL without a duration | Rohan | 2 | Contract tests pass |
| 8 | `parseIntent` + routing eval set (see tests) | Keith | 3 | Eval set passes |
| 9 | `compose` + `check` (grounding validator, template fallback, disclosure of missing skills) | Keith | 3, 4–7 | Grounding tests pass |
| 10 | Photon adapter + `app.chat_context` | Keith | 3 | Real iMessage round trip |
| 11 | Deploy: `compose.yaml` service for `mvp/apps/agent` on the droplet, ingest job via `Dockerfile.ingest`, `/healthz` with git SHA | Keith / Rohan | 10 | Droplet answers a real text |
| 12 | Demo script: 5 prompts rehearsed live, timings recorded | All | 11 | Acceptance checklist below all ticked |

Tickets 4–7 run in parallel as soon as 2 lands. Merge each only when its contract tests pass.

## Tests

**Per skill** (msw for HTTP, a test Postgres or fixture rows for SQL): success, empty result, timeout, partial result, bad input rejected by the zod schema.

**Routing eval set** (`router`, Gemini faked by recorded fixtures, plus an opt-in live run):

| Prompt | Expected `needs` |
|---|---|
| "Is it safe around me?" | `[safety]` |
| "Where should we get dinner?" | `[food]` (+ `route` for top pick) |
| "What fun stuff is nearby tonight?" | `[events]` |
| "How do I get to Jin Ramen?" | `[route]` |
| "Plan a fun and safe night near Columbia" | `[events, food, safety]` + `route` |
| any of the above with no location | `needsClarification`, no skill calls |

**Grounding:** compose output citing an ID not in the results → template fallback. A URL not in the results → template fallback. One skill `unavailable` → reply discloses it and still answers.

**Privacy:** no phone numbers or exact coordinates in logs (pino redaction test).

## Acceptance checklist

- [ ] Real iMessage with shared location + "plan a fun and safe night near me" → one reply
- [ ] Contains a real restaurant or event with a source link
- [ ] Contains a sourced safety note (historical reports, with the data's timestamp)
- [ ] Contains a real travel duration from the Routes API
- [ ] Maps link opens directions
- [ ] Each focused prompt from the eval set returns only what was asked
- [ ] Killing one skill's API key → reply still sent, missing part disclosed
- [ ] Runs on the droplet, deployed by CI from this branch or `main`

## Out of scope for the MVP

Payments/XRPL, ticketing, reservations and phone calls, voice, meetups/ledger, Backboard memory, DeepSpace, website sign-in, the job queue, Tavily enrichment (stretch only after acceptance), porting ingestion to TypeScript, deleting old `src/` code.

## Open decisions

1. **Messaging provider for group chat.** Ticket 0 decides whether Photon's shared pool can work in a group with unregistered members. If not, the MVP demos 1:1 and the team picks a provider separately.
2. **Gemini model.** Must support structured output on the team's key and quota (ticket 0).
3. **Events owner name** for the ticket table.
