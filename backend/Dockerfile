# Sentinel gateway — production image (also used by Railway when it detects the Dockerfile).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY sql ./sql
# The JSONL audit fallback writes here when no DATABASE_URL is set (mount a volume to keep it).
RUN mkdir -p /data && chown node:node /data
ENV AUDIT_PATH=/data/audit.jsonl PORT=4000
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:${PORT}/api/health || exit 1
CMD ["node", "dist/index.js"]
