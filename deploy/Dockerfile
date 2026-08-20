ARG XERO_BUILD_IDENTITY_JSON
ARG XERO_BUILD_IDENTITY_HASH
ARG XERO_ACCEPTANCE_SOURCE_SHA256
ARG XERO_SOURCE_ARCHIVE_SHA256

FROM node:22.22.3-alpine3.23@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS build-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM build-deps AS build
ARG XERO_BUILD_IDENTITY_HASH
ARG XERO_ACCEPTANCE_SOURCE_SHA256
ARG XERO_SOURCE_ARCHIVE_SHA256
COPY . .
RUN rm -rf node_modules
RUN node scripts/verify-accepted-build-context.mjs \
      --root /app \
      --expected-build-identity-hash "${XERO_BUILD_IDENTITY_HASH}" \
      --expected-acceptance-source-sha256 "${XERO_ACCEPTANCE_SOURCE_SHA256}" \
      --expected-source-archive-sha256 "${XERO_SOURCE_ARCHIVE_SHA256}"
COPY --from=build-deps /app/node_modules ./node_modules
RUN npm run build

FROM node:22.22.3-alpine3.23@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force

FROM node:22.22.3-alpine3.23@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920 AS runtime

ARG XERO_BUILD_IDENTITY_JSON
ARG XERO_BUILD_IDENTITY_HASH
ARG XERO_ACCEPTANCE_SOURCE_SHA256
ARG XERO_SOURCE_ARCHIVE_SHA256

RUN test -n "${XERO_BUILD_IDENTITY_JSON}" \
    && test -n "${XERO_BUILD_IDENTITY_HASH}" \
    && test -n "${XERO_ACCEPTANCE_SOURCE_SHA256}" \
    && test -n "${XERO_SOURCE_ARCHIVE_SHA256}"

LABEL org.opencontainers.image.version="0.4.0-rc.1" \
      io.zcloak.xero.build-identity-hash="${XERO_BUILD_IDENTITY_HASH}" \
      io.zcloak.xero.acceptance-source-sha256="${XERO_ACCEPTANCE_SOURCE_SHA256}" \
      io.zcloak.xero.source-archive-sha256="${XERO_SOURCE_ARCHIVE_SHA256}"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    XERO_BUILD_IDENTITY_JSON=${XERO_BUILD_IDENTITY_JSON} \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN addgroup -S -g 10001 app \
    && adduser -S -D -H -u 10001 -G app app

WORKDIR /app

COPY --from=production-deps --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/migrations ./migrations
COPY --from=build --chown=10001:10001 /app/package.json ./package.json

USER 10001:10001

EXPOSE 3000

CMD ["npm", "run", "start"]
