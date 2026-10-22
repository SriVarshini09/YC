# SHAPI server image: one image, two processes (web and worker), chosen by the start command.

FROM node:24-bookworm AS build
WORKDIR /repo
RUN corepack enable
# Workspace manifests first, so dependency install is cached across source changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/extractor/package.json packages/extractor/
COPY packages/shapes/package.json packages/shapes/
COPY packages/canary/package.json packages/canary/
COPY packages/repair/package.json packages/repair/
COPY packages/github-app/package.json packages/github-app/
COPY packages/mcp/package.json packages/mcp/
COPY packages/cli/package.json packages/cli/
COPY packages/cli/bin packages/cli/bin
COPY packages/canary/bin packages/canary/bin
COPY packages/mcp/bin packages/mcp/bin
COPY packages/db/package.json packages/db/
COPY packages/sandbox/package.json packages/sandbox/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
# Rebuild native modules (better-sqlite3) for this platform, then build every package.
RUN pnpm rebuild better-sqlite3 && pnpm -r build
# A self-contained copy of the server with production dependencies only.
RUN pnpm --filter @shapi/server deploy --prod --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    SHAPI_ADVISORIES=/app/advisories
WORKDIR /app
COPY --from=build /out ./
COPY advisories ./advisories
USER node
EXPOSE 8080
CMD ["node", "dist/web.js"]
