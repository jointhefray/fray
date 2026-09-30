# Multi-stage build: compile TypeScript, then ship a lean runtime image.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Per-epoch PEM keypairs live here; volume-mount it so keys survive restarts
# and the previous epoch's key remains available across the rotation window.
# Owned by the runtime user so a fresh named volume inherits writable ownership.
RUN mkdir -p /app/keys && chown node:node /app/keys
VOLUME /app/keys
ENV KEYS_DIR=/app/keys
ENV HOST=0.0.0.0
EXPOSE 8081
USER node
# This image runs the explicitly opted-in local example. Replace its auth hook
# and entrypoint before building a production issuer image.
CMD ["node", "dist/example.js"]
