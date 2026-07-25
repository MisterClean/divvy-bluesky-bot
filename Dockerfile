FROM node:24-alpine3.23 AS build

WORKDIR /app

RUN apk add --no-cache g++ make python3

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine3.23 AS production-dependencies

ARG TARGETARCH

WORKDIR /app

RUN apk add --no-cache g++ make python3

COPY package.json package-lock.json ./
RUN case "$TARGETARCH" in \
      amd64) agent_browser_arch=x64 ;; \
      arm64) agent_browser_arch=arm64 ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && npm ci --omit=dev \
    && find node_modules/agent-browser/bin \
      -maxdepth 1 \
      -type f \
      -name 'agent-browser-*' \
      ! -name "agent-browser-linux-musl-$agent_browser_arch" \
      -delete \
    && chmod 0755 \
      "node_modules/agent-browser/bin/agent-browser-linux-musl-$agent_browser_arch"

FROM node:24-alpine3.23 AS runtime

ENV NODE_ENV=production
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV HOME=/tmp/home

WORKDIR /app

RUN apk add --no-cache \
      chromium \
      chromium-swiftshader \
      font-noto-emoji \
      font-noto-symbols \
    && mkdir -p /var/lib/divvy-bot /app/data /app/output \
    && chown -R node:node /var/lib/divvy-bot /app/data /app/output

COPY package.json package-lock.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY assets ./assets

USER node

CMD ["node", "dist/src/cli.js", "run"]
