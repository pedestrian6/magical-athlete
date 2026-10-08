# syntax=docker/dockerfile:1
FROM node:24.19.0-bookworm-slim AS dependencies
WORKDIR /app
RUN npm install --global pnpm@11.19.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN pnpm build && node scripts/build-online.mjs

FROM dependencies AS production-dependencies
RUN pnpm prune --prod

FROM node:24.19.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data STATIC_DIR=/app/dist SERVER_STATUS_FILE=/app/data/status.json
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --chown=node:node scripts/sqlite-maintenance.mjs ./scripts/sqlite-maintenance.mjs
RUN mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups
USER node
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["node", "--enable-source-maps", "dist-server/server.mjs"]
