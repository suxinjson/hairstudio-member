FROM node:22-alpine AS build
WORKDIR /app
RUN npm config set registry https://registry.npmmirror.com
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY admin/package.json ./admin/package.json
COPY vendor ./vendor
RUN npm ci
COPY . .
ARG VITE_CLOUD_SERVER_URL=https://124.70.184.136
ARG VITE_LICENSE_PUBLIC_KEYS
RUN npm run build:web
RUN npm run admin:build

FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=48927
RUN npm config set registry https://registry.npmmirror.com
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY vendor ./vendor
RUN npm ci --workspace=server --omit=dev --ignore-scripts
COPY server ./server
COPY src/money.js src/data-limits.js src/voice-text.js src/store-profile.js src/license-policy.js src/canonical-json.js src/ledger-domain.js src/relational-contract.js src/relational-sales.js src/relational-reports.js src/relational-tasks.js src/ledger-epoch.js ./src/
COPY capacitor.config.json ./
COPY src/relational-backup-rows.js src/relational-task-result-tables.js src/relational-restore.js ./src/
COPY src/relational-batches.js src/relational-archive.js src/relational-pg-archive-tables.js src/relational-opening-contract.js src/relational-replica.js ./src/
COPY src/relational-export-sheet.js src/relational-presentation.js src/relational-member-totals.js ./src/
RUN mkdir -p /app/releases && chown -R node:node /app
USER node
EXPOSE 48927
CMD ["node", "server/main.js"]

FROM caddy:2-alpine AS web
COPY --from=build /app/dist /srv
COPY --from=build /app/admin/dist /srv/admin
COPY deploy/Caddyfile /etc/caddy/Caddyfile
