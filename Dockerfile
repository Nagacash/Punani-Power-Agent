# Punani powerd by Naga Codex
#
# A small image: the CLI is plain Node with no native modules, so there is
# nothing to compile and the whole thing runs on the base image.

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY bundled ./bundled
RUN npm run build

# Drop the dev dependencies from the runtime image.
RUN npm prune --omit=dev


FROM node:22-alpine AS runtime
WORKDIR /app

# The config file holds API keys, so keep it out of the image and mount it.
ENV PUNANI_CONFIG=/config/config.json
ENV XDG_DATA_HOME=/data
ENV XDG_CONFIG_HOME=/config
ENV XDG_STATE_HOME=/state

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

RUN mkdir -p /config /data /state && chown -R node:node /config /data /state
USER node

# The browser interface. Bind to 0.0.0.0 inside the container, but only
# publish it to the host on 127.0.0.1.
EXPOSE 4096
ENTRYPOINT ["node", "dist/main.js"]
CMD ["web", "--host", "0.0.0.0", "--port", "4096"]
