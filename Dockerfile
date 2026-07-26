FROM node:20-alpine

# Install onchainos CLI from GitHub release (musl build for Alpine Linux)
ARG ONCHAINOS_VERSION=v4.2.0
RUN apk add --no-cache curl ca-certificates && \
    curl -sSL -o /usr/local/bin/onchainos \
      "https://github.com/okx/onchainos-skills/releases/download/${ONCHAINOS_VERSION}/onchainos-x86_64-unknown-linux-musl" && \
    chmod +x /usr/local/bin/onchainos && \
    onchainos --version

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install production dependencies only (skip devDeps like canvas that need native build tools)
RUN npm install --omit=dev

# Copy source files
COPY src/ ./src/
COPY okx-agent-server.js ./

# Copy heartbeat scripts
COPY entrypoint.sh /app/entrypoint.sh
COPY heartbeat.sh /app/heartbeat.sh
RUN chmod +x /app/entrypoint.sh /app/heartbeat.sh

# Build TypeScript
RUN npx tsc --noEmit || echo "Build warning: continuing with tsx runtime"

# Environment
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Entrypoint handles heartbeat + A2MCP
ENTRYPOINT ["/app/entrypoint.sh"]
