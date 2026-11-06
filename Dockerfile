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
COPY src/storage.js src/accounting.js src/money.js src/sync-protocol.js src/cloud-storage.js src/data-limits.js src/recharge-settings.js src/ledger-access.js src/member-tags.js ./src/
COPY capacitor.config.json ./
RUN mkdir -p /app/releases && chown -R node:node /app
USER node
EXPOSE 48927
CMD ["node", "server/main.js"]

FROM caddy:2-alpine AS web
COPY --from=build /app/dist /srv
COPY --from=build /app/admin/dist /srv/admin
COPY deploy/Caddyfile /etc/caddy/Caddyfile
