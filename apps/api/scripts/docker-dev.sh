#!/bin/sh
# Generate .dev.vars from compose env, then run wrangler on 0.0.0.0:8787.
set -eu

api_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
workspace_root=$(CDPATH= cd -- "$api_dir/../.." && pwd)
workspace_modules="$workspace_root/node_modules"
workspace_lock="$workspace_root/package-lock.json"
install_stamp="$workspace_modules/.videoq-package-lock"

# Named volume for the workspace node_modules may be empty or stale.
needs_npm_ci=0
if [ ! -x "$workspace_modules/.bin/wrangler" ]; then
  needs_npm_ci=1
elif ! node -e 'for (const name of ["@hono/trpc-server", "@videoq/trpc"]) require.resolve(name, { paths: [process.argv[1]] })' "$api_dir" >/dev/null 2>&1; then
  # npm may install a dependency under apps/api/node_modules instead of
  # hoisting it. Resolve from the API to avoid reinstalling on every restart.
  needs_npm_ci=1
elif [ ! -f "$install_stamp" ] \
  || ! cmp -s "$workspace_lock" "$install_stamp" 2>/dev/null; then
  needs_npm_ci=1
fi
if [ "$needs_npm_ci" -eq 1 ]; then
  echo "Installing API workspace dependencies (npm ci)..."
  (cd "$workspace_root" && npm ci --workspace @videoq/api)
  cp "$workspace_lock" "$install_stamp"
fi

cat > "$api_dir/.dev.vars" <<EOF
AUTH_JWT_SECRET=${AUTH_JWT_SECRET:-dev-only-auth-jwt-secret-change-me}
USER_SECRET_ENCRYPTION_KEY=${USER_SECRET_ENCRYPTION_KEY:-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
OPENAI_BASE_URL=${OPENAI_BASE_URL:-}
LLM_BASE_URL=${LLM_BASE_URL:-}
LLM_API_KEY=${LLM_API_KEY:-}
LLM_MODEL=${LLM_MODEL:-gpt-6-luna}
VIDEO_VISUAL_ENABLED=${VIDEO_VISUAL_ENABLED:-true}
EMBEDDING_MODEL=${EMBEDDING_MODEL:-}
EMBEDDING_BASE_URL=${EMBEDDING_BASE_URL:-}
EMBEDDING_API_KEY=${EMBEDDING_API_KEY:-}
DEFAULT_FROM_EMAIL=${DEFAULT_FROM_EMAIL:-noreply@videoq.local}
MAILGUN_API_KEY=${MAILGUN_API_KEY:-}
MAILGUN_SENDER_DOMAIN=${MAILGUN_SENDER_DOMAIN:-mg.videoq.jp}
USE_S3_STORAGE=${USE_S3_STORAGE:-true}
R2_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID:-GK00000000000000000000000000000000}
R2_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY:-0000000000000000000000000000000000000000000000000000000000000000}
R2_S3_ENDPOINT=${R2_S3_ENDPOINT:-http://127.0.0.1:9000}
R2_S3_INTERNAL_ENDPOINT=${R2_S3_INTERNAL_ENDPOINT:-http://garage:3900}
R2_BUCKET_NAME=${R2_BUCKET_NAME:-videoq-media}
R2_S3_REGION=${R2_S3_REGION:-garage}
SQS_QUEUE_URL=${SQS_QUEUE_URL:-http://elasticmq:9324/000000000000/videoq-jobs}
AWS_REGION=${AWS_REGION:-us-east-1}
AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-local}
AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-local}
EOF

export CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE="${CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE:-postgresql://postgres:postgres@postgres:5432/postgres}"

cd "$api_dir"
exec npx wrangler dev --ip 0.0.0.0 --port 8787 --local-protocol http
