# syntax=docker/dockerfile:1
#
# Nocturne Console — container image for Cloud Run.
#
# Build context is nocturne_dashboard/, not the repo root. The Dockerfile at the
# repo root belongs to the Python crawler and builds something entirely
# different; do not conflate the two.

# ---- builder ---------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app

# puppeteer is a devDependency used only by the local click tests. Left alone it
# downloads a ~150MB Chromium on every image build, for nothing.
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# The build never contacts Snowflake: every API route is `force-dynamic` and the
# pages fetch from /api/* in the browser. So no credentials are needed here, and
# none should be — see .dockerignore.
RUN npm run build

# ---- runtime ---------------------------------------------------------------
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run injects PORT at runtime; 8080 is its default and the right fallback
# for `docker run` locally. HOSTNAME must be 0.0.0.0 or the server binds to
# localhost inside the container and Cloud Run's health check never connects.
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# `output: "standalone"` emits server.js plus only the node_modules the build
# actually traced. static/ and public/ are deliberately excluded from that
# trace, so they have to be copied across by hand.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 8080

CMD ["node", "server.js"]
