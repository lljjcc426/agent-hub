ARG NODE_IMAGE=public.ecr.aws/docker/library/node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
FROM ${NODE_IMAGE} AS build
WORKDIR /opt/roppo
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
COPY plugins ./plugins
RUN npm run build:chat \
    && node --import tsx src/cli.ts backend-plugins pack plugins/backend-opencode/index.ts plugins/backend-opencode/manifest.json dist/engines/opencode \
    && npm prune --omit=dev \
    && test "$(node_modules/.bin/opencode --version)" = "1.19.5"

FROM ${NODE_IMAGE} AS runtime
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get -o Acquire::Retries=3 update && apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Retries=3 update \
    && apt-get -o Acquire::Retries=3 install -y --no-install-recommends git python3 bubblewrap chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/roppo
COPY --from=build /opt/roppo/package*.json ./
COPY --from=build /opt/roppo/node_modules ./node_modules
COPY --from=build /opt/roppo/src ./src
COPY --from=build /opt/roppo/plugins ./plugins
COPY --from=build /opt/roppo/dist ./dist
RUN chmod -R a+rX /opt/roppo/dist/engines
COPY deployment/container-entrypoint.py deployment/MOBY-PROFILES-LICENSE ./deployment/
COPY LICENSE NOTICE THIRD_PARTY.md ./
COPY docs/THIRD_PARTY_CHAT.md docs/THIRD_PARTY_BROWSER.md ./docs/
COPY docs/licenses ./docs/licenses
RUN mkdir -p /data && chown node:node /data
USER node:node
ENV NODE_ENV=production HOME=/data/state/home
EXPOSE 4337
HEALTHCHECK --interval=10s --timeout=4s --start-period=45s --retries=3 CMD ["node", "--import", "tsx", "src/container-cli.ts", "health"]
ENTRYPOINT ["python3", "/opt/roppo/deployment/container-entrypoint.py"]
CMD ["serve"]
