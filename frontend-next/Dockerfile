# Immagine della app Next.js che affianca osTicket PHP sullo stesso database.
# Build: docker build -t osticket-next frontend-next
#        (opzionale: --build-arg NEXT_BASE_PATH=/app per servirla in un sotto-percorso)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
ARG NEXT_BASE_PATH=""
ENV NEXT_OUTPUT=standalone NEXT_BASE_PATH=${NEXT_BASE_PATH} NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# msmtp fa da "sendmail" verso il relay SMTP aziendale quando non si usano gli account SMTP di osTicket
RUN apk add --no-cache msmtp tzdata && addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]
