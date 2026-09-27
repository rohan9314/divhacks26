# DigitalOcean setup: agent + website API (replaces DeepSpace)

The iMessage agent and the website's API run as one container on one droplet, behind Caddy for HTTPS. User accounts live in Tiger (`app.records`), chat memory in `app.chat_context`. The website stays on Vercel. Plan and reasoning: [migration-deepspace-to-digitalocean.md](migration-deepspace-to-digitalocean.md).

```text
plansaroundus.tech (Vercel) ──HTTPS──▶ api.plansaroundus.tech (droplet: Caddy → agent:8080)
                                                         │  Photon listener + /api/* + /healthz
                                                         ▼
                                                 Tiger Postgres (app.*, nypd_complaints, city_events)
```

Already done: both migrations are applied to Tiger (`app.chat_context`, `app.records`).

## 1. Create the droplet (someone with the DigitalOcean account)

- Ubuntu 24.04, Basic, 2 GB RAM / 1 vCPU is enough. Region NYC.
- Add the SSH public keys of everyone who should be able to deploy (at least two people).
- Note the droplet's public IPv4.

## 2. DNS

Add an `A` record: `api.plansaroundus.tech` → droplet IPv4. Wait until `dig +short api.plansaroundus.tech` returns it. Caddy needs this before it can get a certificate.

## 3. Install Docker and get the code (on the droplet)

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/rohan9314/divhacks26.git && cd divhacks26
git checkout mvp-site-api   # until it's merged; then main
```

## 4. Secrets (`mvp/.env` on the droplet only; never commit it)

```bash
cp mvp/.env.example mvp/.env
openssl rand -hex 32        # paste as SITE_AUTH_SECRET
```

Fill in `mvp/.env`:

| Variable | From |
|---|---|
| `DOMAIN` | `api.plansaroundus.tech` |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Google AI Studio |
| `GOOGLE_MAPS_API_KEY` | Google Cloud, restricted to Places API (New) + Routes API |
| `DATABASE_URL` | Tiger (same as today) |
| `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` | app.photon.codes (same project the friend's agent uses) |
| `SITE_AUTH_SECRET` | the `openssl` output above |
| `RESEND_API_KEY`, `EMAIL_FROM` | Resend; the sender domain must be verified there. It's the key DeepSpace had as a secret |
| `WEB_ALLOWED_ORIGINS` | `https://plansaroundus.tech,https://www.plansaroundus.tech` |

## 5. Start it

```bash
docker compose -f mvp/compose.yaml --profile tools run --rm migrate   # safe to rerun
```

**Stop the agent on the friend's computer before the next step.** Only one listener per Photon project, or people get two replies.

```bash
GIT_SHA=$(git rev-parse --short HEAD) docker compose -f mvp/compose.yaml up -d --build
docker compose -f mvp/compose.yaml logs -f agent      # "agent started"
curl -s https://api.plansaroundus.tech/healthz
```

`/healthz` should show `"channel":"photon"`, `"site":true`, `"photon":true`, `"email":"resend"`, `"chatMemory":"tiger"` and the git SHA as `version`.

## 6. Point the website at it

In Vercel → project → Settings → Environment Variables, set `VITE_AGENT_API_URL=https://api.plansaroundus.tech` for Production and redeploy.

The path moves from DeepSpace's `https://plans-around-us.app.space/api/site` to the droplet root. The site calls `${VITE_AGENT_API_URL}/api/...` either way.

## 7. Check it end to end

- [ ] `https://plansaroundus.tech` loads with no failed `/api/stats` request in the browser console
- [ ] Sign up with a real email and iPhone. The code email arrives; the site shows `CODE ######` and *your own* @agent number
- [ ] Text the code. @agent replies "You're verified!" and the site moves on by itself
- [ ] Onboarding saves; "Send me a hello" delivers an iMessage; "Email me my @agent number" arrives
- [ ] Text @agent "is it safe around here?" with a shared location. You get a sourced reply
- [ ] Settings → delete account signs you out

The 4 people who signed up on DeepSpace sign up again (decided 2026-09-27). Nothing is migrated.

## Deploying updates

```bash
cd divhacks26 && git pull
docker compose -f mvp/compose.yaml --profile tools run --rm migrate
GIT_SHA=$(git rev-parse --short HEAD) docker compose -f mvp/compose.yaml up -d --build
```

## Rollback

1. Set `VITE_AGENT_API_URL` back to `https://plans-around-us.app.space/api/site` in Vercel and redeploy.
2. `docker compose -f mvp/compose.yaml down` on the droplet, then restart the friend's agent.

Keep DeepSpace deployed for a week after cutover. Then delete `backend/`, `backend-old/` and the agent's `src/deepspace/`.
