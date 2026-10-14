FROM node:24-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 downloads a prebuilt binary; if none fits, it compiles, which needs these.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS run
WORKDIR /app
# NEXT_MANUAL_SIG_HANDLE: on `docker stop` (or a host stopping the instance) the
# server first backs the index up to Telegram and hands the drive over.
# KEEP_ALIVE_TIMEOUT: idle connections outlive the host's proxy (else resets / 502s).
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_MANUAL_SIG_HANDLE=true \
    KEEP_ALIVE_TIMEOUT=120000 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data
RUN groupadd --system app && useradd --system --gid app app && mkdir -p /data && chown app:app /data
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/scripts ./scripts
USER app
VOLUME ["/data"]
EXPOSE 3000
# Hosts that set their own PORT (Render, Koyeb, …) are followed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
# Listen on every interface even where the platform sets HOSTNAME to the
# container's name; `exec` keeps node as PID 1, so it receives SIGTERM itself.
CMD ["sh", "-c", "HOSTNAME=0.0.0.0 exec node server.js"]
