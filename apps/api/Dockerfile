# Production on-prem Node runtime. The Cloudflare entrypoint remains separate.
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS base

# BEGIN managed npm
ARG NPM_VERSION=12.2.2
ARG NPM_URL=https://registry.npmjs.org/npm/-/npm-12.2.2.tgz
ARG NPM_INTEGRITY=sha512-KglgbZyacf7jH+FHuNRqVuCzQi8VhI2a7J87Ix43FsPTuZoGWmIXXGdZtBUOA79vwL+IJREqURVzupA7PsQTcA==
RUN node --input-type=module -e 'import {createHash} from "node:crypto"; import {writeFileSync} from "node:fs"; const r=await fetch(process.env.NPM_URL); if(!r.ok) throw new Error("npm download failed"); const b=Buffer.from(await r.arrayBuffer()); if("sha512-"+createHash("sha512").update(b).digest("base64")!==process.env.NPM_INTEGRITY) throw new Error("npm integrity mismatch"); writeFileSync("/tmp/npm.tgz",b)' \
    && mkdir -p /opt/verified-npm \
    && tar -xzf /tmp/npm.tgz -C /opt/verified-npm --strip-components=1 \
    && ln -sf /opt/verified-npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /opt/verified-npm/bin/npx-cli.js /usr/local/bin/npx \
    && rm /tmp/npm.tgz \
    && test "$(npm --version)" = "$NPM_VERSION"
# END managed npm

FROM base AS build
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/trpc/package.json packages/trpc/package.json
RUN npm ci --workspace @videoq/api --ignore-scripts
COPY apps/api apps/api
COPY packages/trpc packages/trpc
RUN npm run build:node --workspace @videoq/api

FROM base AS dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/trpc/package.json packages/trpc/package.json
RUN npm ci --workspace @videoq/api --omit=dev --omit=optional --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production
# The final image executes bundled entries; package installation is build-only.
RUN rm -rf /usr/local/lib/node_modules/npm /opt/verified-npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /workspace
COPY --from=dependencies /workspace /workspace
COPY --from=build /workspace/packages/trpc packages/trpc
COPY --from=build /workspace/apps/api/dist apps/api/dist
COPY --from=build /workspace/apps/api/drizzle apps/api/drizzle
COPY --from=build /workspace/apps/api/scripts apps/api/scripts
WORKDIR /workspace/apps/api
COPY LICENSE /usr/share/licenses/videoq/LICENSE
USER node
EXPOSE 8787
CMD ["node", "dist/node.mjs"]
