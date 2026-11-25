# Production on-prem Node runtime. The Cloudflare entrypoint remains separate.
# BEGIN shared OpenSSL security
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS openssl-security-base
ARG OPENSSL_SECURITY_REFRESH=2026-11-25
# Bump this epoch for a trusted repository refresh on a reused local builder.
# CI discards the entire runner-local builder after the job; scans always run.
# The pinned base predates the Alpine zlib security update.
RUN test -n "$OPENSSL_SECURITY_REFRESH" && apk upgrade --no-cache zlib
# Alpine stable still ships OpenSSL 3.5.9-r0. The official r1 backports fix
# CVE-2026-88823, CVE-2026-95691, CVE-2026-95692 and CVE-2026-107496.
RUN apk add --no-cache --upgrade \
    --repository https://dl-cdn.alpinelinux.org/alpine/edge/main \
    'libssl3>=3.5.9-r1' 'libcrypto3>=3.5.9-r1'

FROM openssl-security-base AS openssl-security
# Compile checksum-pinned upstream fixes until Alpine publishes these backports.
RUN apk add --no-cache abuild build-base perl linux-headers
COPY apps/security/openssl /build/openssl
WORKDIR /build/openssl
RUN abuild-keygen -a -n \
    && cp /root/.abuild/*.pub /etc/apk/keys/ \
    && MAKEFLAGS=-j4 abuild -F -d -r \
    && mkdir /security-packages \
    && find /root/packages -name 'libssl3-3.5.9-r100.apk' -exec cp {} /security-packages/ \; \
    && find /root/packages -name 'libcrypto3-3.5.9-r100.apk' -exec cp {} /security-packages/ \; \
    && cp /root/.abuild/*.pub /security-packages/ \
    && test -f /security-packages/libssl3-3.5.9-r100.apk \
    && test -f /security-packages/libcrypto3-3.5.9-r100.apk

# END shared OpenSSL security

FROM openssl-security-base AS base
# BEGIN managed npm
ARG NPM_VERSION=12.2.3
ARG NPM_URL=https://registry.npmjs.org/npm/-/npm-12.2.3.tgz
ARG NPM_INTEGRITY=sha512-ovmNRRe76Jvcp1E6iOePQ6H9Zr4XMOrqgfaeGNhtRvP3XSl2Lo/a9C1N5/jRlLLrsqCem/omgGdZHpZ5a6yn1Q==
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
COPY packages/domain/package.json packages/domain/package.json
RUN npm ci --workspace @videoq/api --ignore-scripts
COPY apps/api apps/api
COPY packages/trpc packages/trpc
COPY packages/domain packages/domain
RUN npm run build:node --workspace @videoq/api

FROM base AS dependencies
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/trpc/package.json packages/trpc/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN npm ci --workspace @videoq/api --omit=dev --omit=optional --ignore-scripts

FROM base AS runtime
COPY --from=openssl-security /security-packages /tmp/security-packages
RUN cp /tmp/security-packages/*.pub /etc/apk/keys/ \
    && apk add --no-network /tmp/security-packages/libcrypto3-3.5.9-r100.apk /tmp/security-packages/libssl3-3.5.9-r100.apk \
    && rm -rf /tmp/security-packages
ENV NODE_ENV=production
# The final image executes bundled entries; package installation is build-only.
RUN rm -rf /usr/local/lib/node_modules/npm /opt/verified-npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /workspace
COPY --from=dependencies /workspace /workspace
COPY --from=build /workspace/packages/trpc packages/trpc
COPY --from=build /workspace/packages/domain packages/domain
COPY --from=build /workspace/apps/api/dist apps/api/dist
COPY --from=build /workspace/apps/api/drizzle apps/api/drizzle
COPY --from=build /workspace/apps/api/scripts apps/api/scripts
WORKDIR /workspace/apps/api
COPY LICENSE /usr/share/licenses/videoq/LICENSE
USER node
EXPOSE 8787
CMD ["node", "dist/node.mjs"]
