#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$ROOT_DIR"
readonly DOCKER_CLI="/usr/bin/docker"
readonly ENV_FILE="/etc/xero-accounting-mcp/release.env"
PATH=/usr/bin:/bin
DOCKER_HOST=unix:///var/run/docker.sock
export PATH DOCKER_HOST
unset DOCKER_CONTEXT DOCKER_CONFIG BUILDX_BUILDER BUILDKIT_HOST

test "$(id -u)" = "0" || {
  printf 'production admission failed: root is required\n' >&2
  exit 77
}

# This command performs the complete artifact/control-root/image pull+inspect
# admission before any container is created, started, or used for migration.
/usr/bin/node scripts/release/production-deployment-admission.mjs >/dev/null

case "${1:-}" in
  host-green-up)
    exec "$DOCKER_CLI" compose --env-file "$ENV_FILE" \
      -f deploy/docker-compose/compose.host-nginx.green.vps.yaml \
      up -d --no-build accounting-mcp-green
    ;;
  full-postgres-up)
    exec "$DOCKER_CLI" compose --project-directory . --env-file "$ENV_FILE" \
      -f deploy/docker-compose/compose.vps.yaml up -d --no-build postgres
    ;;
  full-migrate)
    exec "$DOCKER_CLI" compose --project-directory . --env-file "$ENV_FILE" \
      -f deploy/docker-compose/compose.vps.yaml run --rm --no-build accounting-mcp npm run migrate
    ;;
  full-nginx-check)
    exec "$DOCKER_CLI" compose --project-directory . --env-file "$ENV_FILE" \
      -f deploy/docker-compose/compose.vps.yaml run --rm --no-deps --no-build nginx sh -ec \
      'test -r /etc/nginx/tls/privkey.pem && test -r /opt/xero-nginx/proxy_params && nginx -t -c /opt/xero-nginx/nginx.conf'
    ;;
  full-up)
    exec "$DOCKER_CLI" compose --project-directory . --env-file "$ENV_FILE" \
      -f deploy/docker-compose/compose.vps.yaml up -d --no-build accounting-mcp nginx
    ;;
  *)
    printf 'usage: %s {host-green-up|full-postgres-up|full-migrate|full-nginx-check|full-up}\n' "$0" >&2
    exit 2
    ;;
esac
