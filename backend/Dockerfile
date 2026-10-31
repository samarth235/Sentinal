# Sentinel gateway API. Runs the TypeScript sources with tsx (no separate compile step yet).
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY sql ./sql

ENV NODE_ENV=production \
    PORT=4000
EXPOSE 4000
USER node

# tsx forwards SIGTERM, so the server's graceful shutdown runs on `docker stop`.
CMD ["node_modules/.bin/tsx", "src/index.ts"]
