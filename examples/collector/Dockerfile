# Build from the REPO ROOT so the normative /spec can be copied into the image:
#   docker build -f examples/collector/Dockerfile -t fray-collector-example .
# (docker-compose.yml at the repo root does this for you.)
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY examples/collector/package.json examples/collector/package-lock.json ./examples/collector/
RUN cd examples/collector && npm ci --omit=dev
# The collector validates against the same schema bytes the spec publishes.
COPY spec ./spec
COPY examples/collector/src ./examples/collector/src
COPY examples/collector/watchlist.sample.json ./examples/collector/
WORKDIR /app/examples/collector
EXPOSE 8082
USER node
CMD ["node", "src/index.js"]
