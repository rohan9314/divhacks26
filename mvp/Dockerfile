# Around Me MVP agent: one process (channel adapter + router + skills).
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Workspace manifests first so dependency installs cache across source edits.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/router/package.json packages/router/
COPY packages/skills/safety/package.json packages/skills/safety/
COPY packages/skills/events/package.json packages/skills/events/
COPY packages/skills/food/package.json packages/skills/food/
COPY packages/skills/route/package.json packages/skills/route/
COPY apps/agent/package.json apps/agent/
# tsx runs the TypeScript sources directly, so dev dependencies stay installed.
RUN npm ci --include=dev && npm cache clean --force

COPY tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
USER node
EXPOSE 8080
CMD ["npx", "tsx", "apps/agent/src/main.ts"]
