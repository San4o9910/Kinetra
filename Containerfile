FROM node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34 AS build

WORKDIR /src

ENV NPM_CONFIG_UPDATE_NOTIFIER=false

COPY package.json package-lock.json .nvmrc ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN set -eux; \
    test "$(node --version)" = "v22.16.0"; \
    test "$(npm --version)" = "10.9.2"; \
    npm ci --no-audit --no-fund

COPY tsconfig.base.json tsconfig.base.json
COPY packages/shared/tsconfig.json packages/shared/tsconfig.json
COPY packages/shared/src packages/shared/src
COPY apps/backend/tsconfig.json apps/backend/tsconfig.json
COPY apps/backend/tsconfig.build.json apps/backend/tsconfig.build.json
COPY apps/backend/src apps/backend/src
COPY apps/backend/migrations apps/backend/migrations
COPY apps/backend/scripts/migrate.mjs apps/backend/scripts/migrate.mjs
COPY apps/frontend/tsconfig.json apps/frontend/tsconfig.json
COPY apps/frontend/vite.config.ts apps/frontend/vite.config.ts
COPY apps/frontend/index.html apps/frontend/index.html
COPY apps/frontend/src apps/frontend/src
COPY apps/frontend/public apps/frontend/public

# These values are compiled into the browser bundle and therefore must be public.
ARG VITE_API_URL=""
ARG VITE_PRIVATE_MEDIA_ORIGIN=""
ARG VITE_APP_VERSION=""
ARG VITE_PRIVACY_URL=""
ARG VITE_SUPPORT_EMAIL=""

RUN set -eux; \
    VITE_API_URL="${VITE_API_URL}" \
    VITE_PRIVATE_MEDIA_ORIGIN="${VITE_PRIVATE_MEDIA_ORIGIN}" \
    VITE_APP_VERSION="${VITE_APP_VERSION}" \
    VITE_PRIVACY_URL="${VITE_PRIVACY_URL}" \
    VITE_SUPPORT_EMAIL="${VITE_SUPPORT_EMAIL}" \
      npm run build; \
    npm prune --omit=dev --no-audit --no-fund; \
    test -f packages/shared/dist/index.js; \
    test -f apps/backend/dist/server.js; \
    test -f apps/frontend/dist/index.html; \
    node --check apps/backend/dist/server.js; \
    node -e "import('bcrypt').then(async ({ hash }) => { await hash('container-abi-check', 10); })"

# Export-only target. It contains no server, shell, package manager, or default command.
FROM scratch AS frontend-files

COPY --from=build /src/apps/frontend/dist/ /

FROM node:22.16.0-bookworm-slim@sha256:048ed02c5fd52e86fda6fbd2f6a76cf0d4492fd6c6fee9e2c463ed5108da0e34 AS backend-runtime

ARG DEBIAN_SNAPSHOT=20250611T000000Z

RUN set -eux; \
    test "${DEBIAN_SNAPSHOT}" = "20250611T000000Z"; \
    test "$(dpkg-query -W -f='${Status}' ca-certificates)" = 'install ok installed'; \
    rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; \
    printf '%s\n' \
      'Types: deb' \
      "URIs: https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/" \
      'Suites: bookworm bookworm-updates' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
      'Check-Valid-Until: no' \
      '' \
      'Types: deb' \
      "URIs: https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/" \
      'Suites: bookworm-security' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
      'Check-Valid-Until: no' \
      > /etc/apt/sources.list.d/debian-snapshot.sources; \
    apt-get -o Acquire::Check-Valid-Until=false update; \
    apt-get install -y --no-install-recommends \
      'ffmpeg=7:5.1.6-0+deb12u1' \
      'imagemagick=8:6.9.11.60+dfsg-1.6+deb12u3' \
      'tini=0.19.0-1'; \
    test "$(dpkg-query -W -f='${Version}' ffmpeg)" = '7:5.1.6-0+deb12u1'; \
    test "$(dpkg-query -W -f='${Version}' imagemagick)" = '8:6.9.11.60+dfsg-1.6+deb12u3'; \
    test "$(dpkg-query -W -f='${Version}' tini)" = '0.19.0-1'; \
    ffmpeg -version; \
    ffprobe -version; \
    identify -version; \
    convert -version; \
    rm -rf /var/lib/apt/lists/*

# These are the identity of the reviewed release definition containing this Containerfile. They
# are intentionally distinct from the immutable application source labels below.
ARG RELEASE_DEFINITION_COMMIT
ARG RELEASE_DEFINITION_TREE

RUN set -eux; \
    test "${#RELEASE_DEFINITION_COMMIT}" -eq 40; \
    test "${#RELEASE_DEFINITION_TREE}" -eq 40; \
    case "${RELEASE_DEFINITION_COMMIT}${RELEASE_DEFINITION_TREE}" in \
      *[!0-9a-f]*) exit 1 ;; \
    esac

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TRAINER_VIDEO_UPLOADS_ENABLED=false \
    VIDEO_VERIFY_FFPROBE_PATH=/usr/bin/ffprobe \
    TMPDIR=/tmp \
    MAGICK_TMPDIR=/tmp \
    NPM_CONFIG_UPDATE_NOTIFIER=false

LABEL org.opencontainers.image.title="Kinetra backend runtime" \
      org.opencontainers.image.description="Platform-neutral Kinetra API and one-shot worker runtime" \
      org.opencontainers.image.source="https://github.com/San4o9910/Kinetra" \
      org.opencontainers.image.revision="${RELEASE_DEFINITION_COMMIT}" \
      io.kinetra.release-definition-commit="${RELEASE_DEFINITION_COMMIT}" \
      io.kinetra.release-definition-tree="${RELEASE_DEFINITION_TREE}" \
      io.kinetra.app-source-commit="c5645a3aa84bbc81e688c97731e48d978a2aeb92" \
      io.kinetra.app-source-tree="4ee94cb5d334e54e5996d42caed35e0b3c776a23" \
      io.kinetra.migration-012.sha256="c05550d0bd3dca13b6cf4a4254c677c4348999bcef3b6f9eb8d8ad76df9de7f4"

COPY --from=build --chown=node:node /src/package.json /src/package-lock.json ./
COPY --from=build --chown=node:node /src/node_modules node_modules
COPY --from=build --chown=node:node /src/packages/shared/package.json packages/shared/package.json
COPY --from=build --chown=node:node /src/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /src/apps/backend/package.json apps/backend/package.json
COPY --from=build --chown=node:node /src/apps/backend/dist apps/backend/dist
COPY --from=build --chown=node:node /src/apps/backend/migrations apps/backend/migrations
COPY --from=build --chown=node:node /src/apps/backend/scripts/migrate.mjs apps/backend/scripts/migrate.mjs
COPY --from=build --chown=node:node /src/apps/frontend/package.json apps/frontend/package.json

USER node

RUN set -eux; \
    node --check apps/backend/dist/server.js; \
    node -e "import('bcrypt').then(async ({ hash }) => { await hash('runtime-abi-check', 10); })"; \
    test "$(dpkg-query -W -f='${Version}' ffmpeg)" = '7:5.1.6-0+deb12u1'; \
    test "$(dpkg-query -W -f='${Version}' imagemagick)" = '8:6.9.11.60+dfsg-1.6+deb12u3'; \
    test "$(dpkg-query -W -f='${Version}' tini)" = '0.19.0-1'

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/backend/dist/server.js"]
