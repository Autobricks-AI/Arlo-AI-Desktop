# Arlo Desktop, as an image.
#
# Two stages so the runtime layer carries no compiler, no dev dependencies and no source:
# `vite build` needs all three and the running app needs none of them.

FROM node:22-alpine AS build
WORKDIR /app

# Dependencies before source, so editing a file does not re-run npm ci. `npm ci` rather
# than `npm install` because the lockfile is the point: a build that quietly resolves a
# different version than the one tested is a build that proves nothing.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ----------------------------------------------------------------

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Only what `server/prod.mjs` reaches at runtime. Production deps for the server bundle,
# the built output, and the migrations, which are read from disk at boot, not compiled in.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY server ./server
COPY migrations ./migrations

# Both are volumes in docker-compose.yml. Created here so they exist and belong to `node`
# even when nothing is mounted over them: a first run that cannot write its WhatsApp
# session directory fails at the point somebody is scanning a QR code, which is a
# confusing place to find out about file permissions.
RUN mkdir -p /app/.wa-auth /app/.cache && chown -R node:node /app/.wa-auth /app/.cache

# Not root. Nothing here needs to be, and the app takes uploads from strangers.
USER node

EXPOSE 9005

# HOST=0.0.0.0 binds inside the container only. What decides whether anyone else can reach
# it is the port publishing in docker-compose.yml, which is loopback: see the note there.
ENV HOST=0.0.0.0 \
    PORT=9005 \
    OCR_CACHE_DIR=/app/.cache/tesseract

# No npm in front of it: npm would be PID 1 and would swallow the signals, so `docker stop`
# would wait out its ten seconds and then kill the workers mid-request instead of letting
# prod.mjs shut them down.
CMD ["node", "server/prod.mjs"]
