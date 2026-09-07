# syntax=docker/dockerfile:1

# Built with the repository root as the context, not `backend/`. Two reasons.
# `backend/tsconfig.json` extends `../tsconfig.base.json`, and `tsc` resolves
# that relative to the file, so a context limited to `backend/` would not
# contain it. And `backend` depends on `shared` as an npm workspace, which npm
# resolves to a symlink into a sibling directory that has to be in the context
# for the link to point at anything.

# `node:22-alpine`, not 20. Node 20 left support in April 2026, and a container
# built on an end-of-life runtime receives no further security patches — which
# is not a defensible position for something holding a pharmacy's patient data.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Manifests before sources, so editing a route does not cost a fresh install.
# `shared/package.json` has to be here even though nothing runs it yet: the
# lockfile records the workspace as a link into `shared/`, and `npm ci` fails
# against a lockfile whose workspace target is missing.
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
RUN npm ci --workspace=shared --workspace=backend

COPY tsconfig.base.json ./

# Shared is built first, and separately, because that is the order the code
# requires rather than a preference. `shared/package.json` points `main` and
# `types` at `dist`, so `backend`'s `tsc` reads the *built* shared package and
# never its source. Building them in one step, or in the other order, fails on
# exports that plainly exist in `shared/src` — an error that reads like a typo
# and is actually a missing build.
COPY shared/tsconfig.json shared/tsconfig.build.json ./shared/
COPY shared/src ./shared/src
RUN npm run build --workspace=shared

COPY backend/tsconfig.json backend/tsconfig.build.json ./backend/
COPY backend/src ./backend/src
RUN npm run build --workspace=backend

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/
# Production dependencies only. ts-jest, eslint and typescript are build tools;
# shipping them into the image adds attack surface and a hundred megabytes for
# nothing. `shared` has no runtime dependencies at all — it is deliberately pure
# — but its manifest is still needed for the workspace link to resolve.
RUN npm ci --workspace=shared --workspace=backend --omit=dev && npm cache clean --force

# Both `dist` directories. Omitting `shared/dist` would produce a container that
# builds, starts, and then throws `Cannot find module 'a-and-b-chemist-shared'`
# on the first request that prices a basket.
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/backend/dist ./backend/dist

# The process reads its own `dist` and opens a socket. It does not need root, and
# a container escaped from a non-root user is a materially smaller problem.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 5000

# Node rather than wget: node is certain to be present and its fetch is already
# used by the readiness probe, so the container checks liveness the same way the
# platform does. `start-period` gives a cold boot time to come up before the
# first failure counts.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/health').then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})"

CMD ["node", "backend/dist/server.js"]
