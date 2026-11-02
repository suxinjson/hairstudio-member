FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
RUN npm ci --workspace=server --omit=dev --ignore-scripts
COPY server ./server
COPY src/storage.js src/accounting.js src/money.js src/sync-protocol.js src/cloud-storage.js ./src/
COPY capacitor.config.json ./
RUN mkdir -p /app/releases && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server/main.js"]

FROM caddy:2-alpine AS web
COPY --from=build /app/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
