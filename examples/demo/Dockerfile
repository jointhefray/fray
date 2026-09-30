FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY ohttp/typescript/package.json ohttp/typescript/package-lock.json ./ohttp/typescript/
RUN npm ci --prefix ohttp/typescript
COPY ohttp/typescript/tsconfig.json ./ohttp/typescript/
COPY ohttp/typescript/src ./ohttp/typescript/src
RUN npm run build --prefix ohttp/typescript && npm prune --omit=dev --prefix ohttp/typescript
COPY scripts/demo.mjs ./scripts/demo.mjs
USER node
ENTRYPOINT ["node", "scripts/demo.mjs"]
