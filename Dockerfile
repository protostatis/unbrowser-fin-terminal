FROM node:22.23.2-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-pi-brace-expansion.mjs ./scripts/
RUN npm ci

COPY tsconfig.server.json tsconfig.extension.json vite.config.ts ./
COPY server ./server
COPY shared ./shared
COPY web ./web
COPY .pi/extensions ./.pi/extensions

ARG PUBLIC_BASE_PATH=/
ARG VITE_TERMINAL_BUILD_MODE=
RUN PUBLIC_BASE_PATH="$PUBLIC_BASE_PATH" VITE_TERMINAL_BUILD_MODE="$VITE_TERMINAL_BUILD_MODE" npm run build


FROM node:22.23.2-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/patch-pi-brace-expansion.mjs ./scripts/
RUN npm ci --omit=dev --omit=optional && npm cache clean --force


FROM node:22.23.2-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46 AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    MARKET_ROOT=/app \
    MARKET_DATA_DIR=/data \
    PI_CODING_AGENT_DIR=/data/pi-agent \
    HOME=/tmp/home \
    XDG_CACHE_HOME=/tmp/cache

WORKDIR /app
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-web ./dist-web
# The canonical extension is source-loaded by Pi at runtime. Its concurrent
# research coordinator resolves the compiled worker modules from /app/server.
COPY --from=build /app/dist-server/server ./server
COPY package.json ./package.json
COPY shared ./shared
COPY .pi/extensions ./.pi/extensions

RUN mkdir -p /data/pi-agent && chown -R node:node /data

USER node
EXPOSE 8787
CMD ["node", "dist-server/server/index.js"]
