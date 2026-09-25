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
# The deploy agent and its installer are served to enrolled Plesk servers (the repository is private).
COPY agent agent
# The guide for AI assistants, served at /llms.txt.
COPY docs/llms.txt docs/llms.txt

# Previews are served by the service from this folder; created here so a mounted volume inherits node ownership.
RUN mkdir -p /srv/previews && chown node:node /srv/previews
USER node
WORKDIR /app/apps/mcp-service
EXPOSE 3000
CMD ["node", "--import", "tsx", "src/main.ts"]
