FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
RUN npx playwright install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist

RUN mkdir -p /var/lib/divvy-bot /app/data /app/output \
    && chown -R node:node /var/lib/divvy-bot /app/data /app/output

USER node

CMD ["node", "dist/src/cli.js", "run"]
