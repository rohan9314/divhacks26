# Around Me: MVP

One iMessage with a location → one reply with a real place or event, historical safety context, a travel time and a Maps link. Scope: [`docs/mvp-scope.md`](../docs/mvp-scope.md).

```bash
cd mvp
npm install
cp .env.example .env   # fill what you have; terminal mode runs with nothing set
npm run dev            # terminal chat: paste "40.8075,-73.9626", then "plan a fun and safe night"
npm test               # all skills, router and agent tests (no network)
npm run typecheck && npm run lint
```

## Layout

| Path | What | Owner |
|---|---|---|
| `packages/core` | zod contracts, config, Gemini client, pg, logger, time, geo | Keith |
| `packages/router` | LangGraph turn graph, intent parser, dispatcher, composer, grounding check | Keith |
| `packages/skills/safety` | NYPD complaint history from Tiger | Alan |
| `packages/skills/events` | NYC Parks + permitted events from Tiger | Events owner |
| `packages/skills/food` | Google Places + Gemini re-rank of returned ids | Keith |
| `packages/skills/route` | Google Routes duration + Maps link | Rohan |
| `packages/accounts` | Website sign-in moved from DeepSpace (email code + text-to-verify), Postgres store | Keith |
| `apps/agent` | Photon/terminal adapters, per-chat batching, chat memory, website API (`/api/*`), `/healthz` | Keith |
| `sql/` | `app.chat_context` (chat memory, no phone numbers), `app.records` (website accounts) | Keith |

## The turn

```text
parseIntent (Gemini, keyword fallback)
  → resolveLocations (named place via Places, else last shared pin; none → ask once)
  → runSkill × requested skills, in parallel, each with a timeout
  → route (top pick or named destination)
  → compose (Gemini, facts only) → check (unknown id / link / duration → template reply)
```

Links, the route line and "couldn't reach X" notes are added in code, never by the model.

## Rules for skill owners

- Implement `Skill<I, O>` from `@mvp/core`: a zod `input`, a `timeoutMs`, and `run(input, ctx)`.
- Import only `@mvp/core` and `zod`. Take credentials through your factory, never `process.env`. `router/test/boundaries.test.ts` enforces both.
- Return `unavailable` / `partial` instead of throwing. The dispatcher also catches throws and timeouts.
- Every recommendation needs a stable `id`. The composer may only cite ids you returned.
- Tests: success, empty, provider failure, not configured, bad input. See any `packages/skills/*/test`.

## Website sign-in locally

```bash
SITE_AUTH_SECRET=$(openssl rand -hex 32) TERMINAL_PHONE=+19175550142 AGENT_NUMBER=+15555550100 \
  WEB_ALLOWED_ORIGINS=http://localhost:5176 HTTP_PORT=8790 npm run dev
# in another shell: VITE_AGENT_API_URL=http://localhost:8790 npm --prefix ../frontend run dev -- --port 5176
```

Without `RESEND_API_KEY` the email code prints in the agent's terminal. Type `CODE 123456` there to "text" it as `TERMINAL_PHONE`.

## Deploy (DigitalOcean droplet)

Step by step: [`docs/digitalocean-setup.md`](../docs/digitalocean-setup.md). Only one agent may run per Photon project.
