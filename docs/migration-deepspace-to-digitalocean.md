# Migration plan: DeepSpace → DigitalOcean + Tiger

Status: proposal, not started. Owner: Keith (integration).

## Why

| Problem today | After the move |
|---|---|
| Only one teammate can deploy the backend (`npx deepspace deploy`) and read its logs | CI deploys to one droplet; anyone with access runs `docker compose logs` |
| Site (Vercel, auto-deploys) and backend (manual) drift apart | One `main` build deploys agent + API together |
| Agent and backend talk over signed HTTP (`/api/channels/*`, outbox polling, snapshot pushes, profile sync) | Same process: plain function calls, no shared secrets, no polling |
| User identity lives in three places: DeepSpace `site_users`, Tiger `user_profiles`, local JSON | One set of Postgres tables on Tiger |
| Photon number lookup runs from Cloudflare egress (suspected cause of `number_unavailable`) | Runs from the droplet (hypothesis, verify after cutover) |
| `/me/memories` and `/me/evidence` are stubs on DeepSpace because the data lives in the agent | Served directly by the process that owns the data |

**Not fixed by this:** Photon's shared-pool plan still can't put @agent in a group chat with unregistered people. That is a separate decision about the messaging provider.

## What exists already

- **`backend-old/` is not a DigitalOcean backend.** It's an earlier copy of the DeepSpace app. Delete it.
- **`src/web/` is the pre-DeepSpace site API.** It already serves the exact paths the frontend calls (`/api/auth/*`, `/api/me*`, `/api/stats`, `/api/waitlist`, `/api/integrations`), but stores users in `data/web-users.json` and predates the reversed text-to-verify and per-person Photon numbers.
- **`backend/src/domain/` is the newer logic** (site accounts, text-to-verify, channel identities, plans, outbox, beta, wallets). It's plain TypeScript behind a five-method `Store` interface (`create/update/get/query/remove`) with an in-memory fake and ~500 lines of tests. **It ports without rewriting.**
- **`backend/src/server/site-routes.ts` is already Hono**, which runs on Node through `@hono/node-server`.
- **The DigitalOcean setup is already written:** `compose.yaml` (agent + Caddy + migrate/ingest tools), `deploy/Caddyfile` (routes `/api/*`, `/healthz`, `/webhooks/elevenlabs` to the agent) and `docs/digitalocean-deployment.md`.

## Target

```text
Vercel: frontend/  ──HTTPS──▶  api.plansaroundus.tech  (DigitalOcean droplet)
                                  Caddy (TLS)
                                    └─ agent container (one Node process)
                                         ├─ Photon listener
                                         ├─ Hono API: /api/*  (ported site routes + agent-only routes)
                                         └─ domain services (moved from backend/src/domain)
                                                 │
                                                 ▼
                                         Tiger Postgres (app tables + existing safety/events tables)
```

One process on purpose: the channel routes exist only because the agent and backend were separate. Keep the domain code in its own folder so it can be split into a separate container later if needed.

## Steps

### 1. Port the domain code (~half a day)
- Move `backend/src/domain/*` (and its tests + `testing/fake-store.ts`) into `src/accounts/` (name TBD).
- Replace the `deepspace/worker` `ActionTools` import in `store.ts` with a local `Store` interface of the same shape.
- The domain tests should pass unchanged against the fake store before touching Postgres.

### 2. Postgres `Store` adapter (~half a day)
Fastest path that keeps the domain code untouched: one generic table.

```sql
CREATE TABLE app_records (
  collection  text        NOT NULL,
  record_id   text        NOT NULL DEFAULT gen_random_uuid()::text,
  data        jsonb       NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, record_id)
);
-- One partial unique index per DeepSpace `uniqueOn`, e.g.:
CREATE UNIQUE INDEX ON app_records ((data->>'phone'))      WHERE collection = 'site_users';
CREATE UNIQUE INDEX ON app_records ((data->>'tokenHash'))  WHERE collection = 'site_sessions';
CREATE UNIQUE INDEX ON app_records ((data->>'channel'), (data->>'externalId')) WHERE collection = 'channel_identities';
-- …site_codes.key, site_challenges.tokenHash, site_waitlist.email, site_snapshots.key,
--   beta_invites.codeHash, beta_members.userId, link_codes.codeHash,
--   plan_members(planId,userId), plan_invites.codeHash, preferences(planId,userId),
--   wallets.userId, inbound_deliveries.deliveryKey
```

- `query(collection, { where })` → `data @> $where::jsonb`. `tryInsert` relies on unique violations (`23505`) returning `success: false`.
- Run the same domain tests against a real Postgres (Tiger dev service or local Docker) as a second test target.
- Add as `sql/008_app_records.sql`. Fix the duplicate `004_*` numbering at the same time.
- **Later, optional:** promote hot collections (`site_users`, `site_sessions`, `notification_outbox`) to typed tables once things are stable. Not needed for cutover.

### 3. One API server (~1 day)
- Mount the ported Hono site routes in the agent under `/api/*`, without the `/api/site` prefix. The frontend already calls `${VITE_AGENT_API_URL}/api/...`.
- Take the real implementations from `src/web/server.ts` for the routes DeepSpace stubbed: `/me/memories`, `/me/evidence`, `/me/wallet` (direct call, no `enrollAgentWalletHttp` hop), `/api/calendar.ics`, `/webhooks/elevenlabs`.
- Email: keep only the direct Resend path (`sendWithOwnResend`). Drop the DeepSpace `email/send` proxy.
- Then delete `src/web/auth.ts`, `src/web/store.ts` and the hand-rolled router, so only one site API exists.

### 4. Remove the agent ↔ backend HTTP hop (~half a day)
Replace the `src/deepspace/` client with direct calls:

| Today (HTTP) | After |
|---|---|
| `POST /api/channels/inbound` | `channels.inbound(msg)` |
| outbox poller + `/outbox/ack` | send in process after a plan write; keep the outbox table for retries |
| `/api/channels/directory` | query Postgres |
| `/api/channels/payments/notify` | direct call |
| `/api/channels/snapshots/:key` | write the snapshot row directly |
| `deepspace/profile-sync.ts` (DeepSpace → Tiger) | delete: one users table |

Env vars removed: `DEEPSPACE_API_URL`, `DEEPSPACE_CHANNEL_SECRET`, `DEEPSPACE_OUTBOX_POLL_MS`, `CHANNEL_ADAPTER_SECRET`, `AGENT_ONBOARDING_SECRET`, `DEEPSPACE_ONBOARDING_SECRET`.

### 5. Identity: one users table (decision needed)
`site_users` stores the raw phone number (needed to sign in and to text people), while `user_profiles` stores only a SHA-256 of it. CLAUDE.md says exact phone numbers must not reach Tiger *analytics*.
- **Recommendation:** keep app data in a separate Postgres schema (`app.*`) from analytics tables (`public.*` crime/events). Only the app role can read `app.*`, and analytics queries never join it. Merge `user_profiles` into it keyed by `userId`, with the phone hash kept for lookups.
- Alternative: a separate small Postgres (DigitalOcean Managed) for app data. More isolation, one more service to run.

### 6. Deploy pipeline (~half a day)
- Droplet per `docs/digitalocean-deployment.md`, with `DOMAIN=api.plansaroundus.tech`.
- Drop the `frontend` service from `compose.yaml`; Vercel keeps serving the site. Set `WEB_ALLOWED_ORIGINS=https://plansaroundus.tech`.
- GitHub Actions: on `main`, after typecheck + tests, SSH to the droplet and run `git pull && docker compose up -d --build`. Store the deploy key in repo secrets; give at least two people droplet access.
- Health: keep the `/healthz` booleans and `version`. Make `version` the git SHA so it can't drift.
- Photon listener constraint: exactly **one** agent instance may run. Make sure the friend's machine stops its agent at cutover.

### 7. Data migration (decision needed)
Keith's machine can't read DeepSpace data, so the export has to happen on the friend's side. Options:
1. **Re-sign-up** (recommended if the user count is small): check `GET https://plans-around-us.app.space/api/site/api/stats` first. Sign-up takes a minute and avoids moving session and code tables.
2. **Export route:** add a secret-protected `GET /api/site/export` to the DeepSpace worker that dumps `site_users`, `channel_identities`, `wallets`, `plans*`, `beta_*`. The friend deploys it once, then we import into `app_records`. Skip codes, challenges, sessions and outbox; users sign in again.

Wallets: only public XRPL addresses move. Seeds stay in `data/ripple-demo/secrets.json` on the agent host. Copy that file to the droplet volume manually, never through git or the database.

### 8. Cutover and rollback
1. Deploy the droplet and run `docker compose --profile tools run --rm migrate`.
2. Verify on the droplet (below) while the site still points at DeepSpace.
3. Stop the agent on the friend's machine, then start it on the droplet.
4. Change `VITE_AGENT_API_URL` on Vercel to `https://api.plansaroundus.tech` and redeploy.
5. **Rollback:** point the Vercel env var back and restart the friend's agent. Leave DeepSpace deployed for a week, then delete `backend/`, `backend-old/` and `src/deepspace/`.

## Verification checklist
- [ ] Domain tests pass against the fake store **and** real Postgres
- [ ] `curl https://api.plansaroundus.tech/healthz` shows `photon:true`, `email:"resend"` and the current git SHA
- [ ] Sign-up end to end: email code → phone → site shows `CODE ######` + assigned @agent number → text it → site verifies (this also re-tests the open `number_unavailable` bug)
- [ ] `/me`, preferences save, send-number email, wallet request, delete account
- [ ] `/me/memories` and `/me/evidence` return real data (they were stubs on DeepSpace)
- [ ] An iMessage prompt still gets a reply; the "LINK 123456" flow works in process
- [ ] No raw phone numbers in `public.*` tables or logs

## Rough effort
About 3–4 focused days for one person, most of it steps 3–4. Steps 1–2 can run in parallel with 6.

## Decisions for the team
1. Re-sign-up vs. export route (step 7).
2. App data in a separate `app` schema on Tiger vs. a separate managed Postgres (step 5).
3. Who else gets droplet and deploy access.
