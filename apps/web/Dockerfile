# Immagine di TailTicket (app Next.js) che lavora sullo stesso database di osTicket.
# Build: docker build -t tailticket apps/web
#        (opzionale: --build-arg NEXT_BASE_PATH=/app per servirla in un sotto-percorso)
# Dietro un proxy TLS aziendale: --secret id=build_ca,src=/percorso/ca.crt (non resta nell'immagine).
# Immagine base: in CI si usa un mirror di Docker Hub (--build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-alpine)
ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca npm_config_cafile=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund

FROM ${NODE_IMAGE} AS build
WORKDIR /app
ARG NEXT_BASE_PATH=""
ENV NEXT_OUTPUT=standalone NEXT_BASE_PATH=${NEXT_BASE_PATH} NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# La build non si collega al DB: bastano valori fittizi (come in CI). I font vengono scaricati qui.
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    OST_DB_NAME=build OST_DB_USER=build OST_DB_PASS=build OST_SECRET_SALT=build-only \
    APP_SESSION_SECRET=build-only-build-only-build-only-0123 npm run build

FROM ${NODE_IMAGE} AS run
WORKDIR /app
# il sotto-percorso (già compilato nella build) serve anche a runtime: healthcheck e doctor
ARG NEXT_BASE_PATH=""
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 NEXT_BASE_PATH=${NEXT_BASE_PATH}
# msmtp fa da "sendmail" verso il relay SMTP quando non si usano gli account SMTP di osTicket
RUN apk add --no-cache msmtp tzdata && addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
# registro delle scritture (TAILTICKET_JOURNAL_DIR): un volume nominato eredita il proprietario della cartella
RUN mkdir -p /var/lib/tailticket/journal && chown app:app /var/lib/tailticket/journal
USER app
EXPOSE 3000
LABEL org.opencontainers.image.title="TailTicket" \
      org.opencontainers.image.description="L'helpdesk moderno, compatibile con osTicket" \
      org.opencontainers.image.licenses="GPL-2.0-only"
# /api/health: 200 se l'app è su e raggiunge il DB (anche in sola lettura, "degraded"), 503 se il DB non risponde
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000'+(process.env.NEXT_BASE_PATH||'')+'/api/health',{redirect:'manual'}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
