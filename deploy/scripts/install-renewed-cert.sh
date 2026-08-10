#!/bin/sh
set -eu

: "${RENEWED_LINEAGE:?Certbot must provide RENEWED_LINEAGE}"
: "${MCP_PUBLIC_HOST:?Set MCP_PUBLIC_HOST to the certificate hostname}"
: "${TLS_CERT_DIR:=/srv/xero-accounting-mcp/tls}"
: "${TLS_CERT_OWNER:=root}"
: "${NGINX_RUNTIME_GID:=101}"
: "${DEPLOY_PROJECT_DIR:=/opt/xero-accounting-mcp-demo}"
: "${DEPLOY_ENV_FILE:=${DEPLOY_PROJECT_DIR}/deploy/.env.vps}"

umask 027

install -d -o "${TLS_CERT_OWNER}" -g "${NGINX_RUNTIME_GID}" -m 0750 "${TLS_CERT_DIR}"
install -o "${TLS_CERT_OWNER}" -g "${NGINX_RUNTIME_GID}" -m 0640 \
  "${RENEWED_LINEAGE}/fullchain.pem" "${TLS_CERT_DIR}/fullchain.pem.next"
install -o "${TLS_CERT_OWNER}" -g "${NGINX_RUNTIME_GID}" -m 0640 \
  "${RENEWED_LINEAGE}/privkey.pem" "${TLS_CERT_DIR}/privkey.pem.next"

openssl x509 -in "${TLS_CERT_DIR}/fullchain.pem.next" -noout -checkend 86400
openssl x509 -in "${TLS_CERT_DIR}/fullchain.pem.next" -noout -checkhost "${MCP_PUBLIC_HOST}"
openssl pkey -in "${TLS_CERT_DIR}/privkey.pem.next" -noout >/dev/null

CERT_PUBLIC_KEY_SHA256=$(openssl x509 -in "${TLS_CERT_DIR}/fullchain.pem.next" -pubkey -noout \
  | openssl pkey -pubin -outform DER 2>/dev/null \
  | openssl sha256)
KEY_PUBLIC_KEY_SHA256=$(openssl pkey -in "${TLS_CERT_DIR}/privkey.pem.next" -pubout \
  | openssl pkey -pubin -outform DER 2>/dev/null \
  | openssl sha256)

if [ "${CERT_PUBLIC_KEY_SHA256}" != "${KEY_PUBLIC_KEY_SHA256}" ]; then
  echo "renewed certificate and private key do not match" >&2
  exit 1
fi

mv -f "${TLS_CERT_DIR}/fullchain.pem.next" "${TLS_CERT_DIR}/fullchain.pem"
mv -f "${TLS_CERT_DIR}/privkey.pem.next" "${TLS_CERT_DIR}/privkey.pem"

if docker compose \
  --project-directory "${DEPLOY_PROJECT_DIR}" \
  --env-file "${DEPLOY_ENV_FILE}" \
  -f "${DEPLOY_PROJECT_DIR}/deploy/docker-compose/compose.vps.yaml" \
  ps --status running --services nginx 2>/dev/null | grep -qx nginx; then
  docker compose \
    --project-directory "${DEPLOY_PROJECT_DIR}" \
    --env-file "${DEPLOY_ENV_FILE}" \
    -f "${DEPLOY_PROJECT_DIR}/deploy/docker-compose/compose.vps.yaml" \
    exec -T nginx nginx -s reload
fi
