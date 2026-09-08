# Build context: this repository. A mirror is self-contained: every @theluckystrike
# dependency is vendored under vendor/ with its dist committed, so nothing outside this
# directory is needed. The previous Dockerfile here was copied verbatim from the monorepo
# and did `COPY servers ./servers`, a directory a mirror does not have, so it could never
# build. Fixed 2026-09-08.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY vendor ./vendor
COPY src ./src
RUN npm install --no-audit --no-fund && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY vendor ./vendor
COPY --from=build /app/dist ./dist
RUN npm install --omit=dev --no-audit --no-fund
# stdio server: no port, no entrypoint script, protocol traffic on stdout only.
CMD ["node", "dist/index.js"]
