# Build from the repository root: docker build -f apps/mcp-service/Dockerfile .
FROM node:22-slim
RUN corepack enable
WORKDIR /app

# Dependencies first (cached layer), production only. tsx runs the TypeScript sources directly.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/mcp-service/package.json apps/mcp-service/
RUN pnpm install --frozen-lockfile --prod

COPY packages/shared packages/shared
COPY apps/mcp-service apps/mcp-service

# Previews live on a volume shared with the Nginx edge; created here so the volume inherits node ownership.
RUN mkdir -p /srv/previews && chown node:node /srv/previews
USER node
WORKDIR /app/apps/mcp-service
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/main.ts"]
