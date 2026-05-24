# syntax=docker/dockerfile:1.6

# ---- Build stage ----------------------------------------------------------
# Compile TypeScript with full dev deps. The compiler isn't needed at
# runtime, so we throw the whole stage away afterwards.
FROM node:20-bookworm-slim AS build

WORKDIR /app

ENV CI=true \
    NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json eslint.config.js jest.config.js ./
COPY src ./src

RUN npm run typecheck \
 && npm run lint \
 && npm run build

# Re-resolve a production-only node_modules tree for the final image so we
# never ship ts-jest, eslint, mongodb-memory-server, etc.
RUN npm prune --omit=dev


# ---- Runtime stage --------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# Drop privileges. Bookworm-slim ships a `node` user (uid 1000) intended for
# exactly this. Running as root would mean a container compromise also owns
# /etc inside the container.
USER node
WORKDIR /home/node/app

ENV NODE_ENV=production \
    PORT=3000 \
    NPM_CONFIG_LOGLEVEL=warn

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./

EXPOSE 3000

# Use the lightweight `/health` endpoint (process up; does not exercise
# Mongo/Redis). Orchestrators that care about dependency readiness should
# poll `/ready` instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server.js"]
