FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build

# BEGIN managed npm
ARG NPM_VERSION=12.2.1
ARG NPM_URL=https://registry.npmjs.org/npm/-/npm-12.2.1.tgz
ARG NPM_INTEGRITY=sha512-bKCmFRVT/BB+YPEYbZwQ1XUI3N5t4xKSpU1MxOjo7z3iWzKBJ0ZXRC1xFdEN+TC7N5TdywaBzf2dMXGJq/e2PQ==
RUN node --input-type=module -e 'import {createHash} from "node:crypto"; import {writeFileSync} from "node:fs"; const r=await fetch(process.env.NPM_URL); if(!r.ok) throw new Error("npm download failed"); const b=Buffer.from(await r.arrayBuffer()); if("sha512-"+createHash("sha512").update(b).digest("base64")!==process.env.NPM_INTEGRITY) throw new Error("npm integrity mismatch"); writeFileSync("/tmp/npm.tgz",b)' \
    && mkdir -p /opt/verified-npm \
    && tar -xzf /tmp/npm.tgz -C /opt/verified-npm --strip-components=1 \
    && ln -sf /opt/verified-npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /opt/verified-npm/bin/npx-cli.js /usr/local/bin/npx \
    && rm /tmp/npm.tgz \
    && test "$(npm --version)" = "$NPM_VERSION"
# END managed npm

WORKDIR /workspace

ARG VITE_DEPLOYMENT_EDITION=onprem
ENV VITE_DEPLOYMENT_EDITION=${VITE_DEPLOYMENT_EDITION}

ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL}
ARG VITE_USE_S3_STORAGE=true
ENV VITE_USE_S3_STORAGE=${VITE_USE_S3_STORAGE}
ARG VITE_MAX_VIDEO_UPLOAD_SIZE_MB=500
ENV VITE_MAX_VIDEO_UPLOAD_SIZE_MB=${VITE_MAX_VIDEO_UPLOAD_SIZE_MB}
ARG VITE_OPERATOR_NAME=""
ENV VITE_OPERATOR_NAME=${VITE_OPERATOR_NAME}
ARG VITE_OPERATOR_REPRESENTATIVE=""
ENV VITE_OPERATOR_REPRESENTATIVE=${VITE_OPERATOR_REPRESENTATIVE}
ARG VITE_OPERATOR_EMAIL=""
ENV VITE_OPERATOR_EMAIL=${VITE_OPERATOR_EMAIL}
ARG VITE_OPERATOR_ADDRESS=""
ENV VITE_OPERATOR_ADDRESS=${VITE_OPERATOR_ADDRESS}
ARG VITE_OPERATOR_PHONE=""
ENV VITE_OPERATOR_PHONE=${VITE_OPERATOR_PHONE}

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/docs/package.json apps/docs/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/trpc/package.json packages/trpc/package.json
RUN npm ci --ignore-scripts --workspace @videoq/web --workspace @videoq/api

COPY apps/web apps/web
COPY apps/api apps/api
COPY packages/trpc packages/trpc
RUN npm run build --workspace @videoq/web
RUN if [ "$VITE_DEPLOYMENT_EDITION" = onprem ]; then node apps/web/scripts/check-onprem-build.mjs apps/web/dist; fi
RUN node apps/web/scripts/nginx-headers.mjs /tmp/security-headers.inc.template


FROM nginx:alpine@sha256:785835ea65db4bba6f021acc0f3be91b0fef76a53fe41f8588c6698d2aed0606 AS runtime

# The pinned base predates the Brotli decoder and curl HTTP/2 upload fixes.
RUN apk add --no-cache --upgrade 'brotli-libs>=1.2.1-r0' 'curl>=8.23.0-r0' 'libcurl>=8.23.0-r0'

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /tmp/security-headers.inc.template /etc/nginx/templates/security-headers.inc.template
COPY --chmod=755 apps/web/scripts/15-videoq-csp.envsh /docker-entrypoint.d/15-videoq-csp.envsh
ENV VIDEOQ_CSP_STORAGE_ORIGINS=""

COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
COPY LICENSE /usr/share/licenses/videoq/LICENSE

EXPOSE 80
