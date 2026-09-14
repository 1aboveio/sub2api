#!/bin/bash
set -euo pipefail

if [[ $(id -un) != sub2api ]]; then
  echo "Run this script as the sub2api user." >&2
  exit 1
fi

image=${1:?usage: refresh-runtime-env.sh IMAGE_BY_DIGEST}
project=cosmic-heaven-479306-v5
metadata=http://metadata.google.internal/computeMetadata/v1
export HOME=/home/sub2api
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

token=$(curl -fsS -H 'Metadata-Flavor: Google' \
  "$metadata/instance/service-accounts/default/token" | jq -er .access_token)

printf '%s' "$token" | podman login --username oauth2accesstoken \
  --password-stdin us-central1-docker.pkg.dev >/dev/null

secret_value() {
  local name=$1 value
  value=$(curl -fsS -H "Authorization: Bearer $token" \
    "https://secretmanager.googleapis.com/v1/projects/$project/secrets/$name/versions/latest:access" \
    | jq -er .payload.data | base64 -d)
  if [[ -z $value || $value == *$'\n'* ]]; then
    echo "Secret $name is empty or contains a newline." >&2
    exit 1
  fi
  printf '%s' "$value"
}

db_password=$(secret_value sub2api-db-password)
jwt_secret=$(secret_value sub2api-jwt-secret)
totp_key=$(secret_value sub2api-totp-encryption-key)
admin_password=$(secret_value sub2api-admin-password)

umask 077
printf '%s\n' \
  'SERVER_MODE=release' \
  'RUN_MODE=standard' \
  'LOG_LEVEL=info' \
  'LOG_FORMAT=json' \
  'LOG_ENV=cloudrun' \
  'LOG_OUTPUT_TO_STDOUT=true' \
  'LOG_OUTPUT_TO_FILE=false' \
  'TZ=Asia/Shanghai' \
  'DATABASE_HOST=10.58.0.15' \
  'DATABASE_PORT=5432' \
  'DATABASE_USER=sub2api' \
  "DATABASE_PASSWORD=$db_password" \
  'DATABASE_DBNAME=sub2api' \
  'DATABASE_SSLMODE=require' \
  'REDIS_DB=0' \
  'ADMIN_EMAIL=admin@sub2api.local' \
  "ADMIN_PASSWORD=$admin_password" \
  "JWT_SECRET=$jwt_secret" \
  "TOTP_ENCRYPTION_KEY=$totp_key" > /opt/sub2api/runtime.env

printf 'SUB2API_IMAGE=%s\n' "$image" > /opt/sub2api/compose.env
