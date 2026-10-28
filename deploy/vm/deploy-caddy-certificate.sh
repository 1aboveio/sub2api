#!/bin/bash
set -euo pipefail

if [ "${1:-}" != "--publish" ]; then
  if [ "${RENEWED_LINEAGE:-}" != /etc/letsencrypt/live/sub2api.gapsee.com ]; then
    exit 0
  fi
  if [ "$(id -u)" -ne 0 ]; then
    echo "Certbot deploy hook must run as root" >&2
    exit 1
  fi
  script=$(readlink -f "$0")
  uid=$(id -u sub2api)
  # Read root-owned Certbot files, but publish into the volume without root.
  cat "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" |
    sudo -u sub2api XDG_RUNTIME_DIR="/run/user/$uid" "$script" --publish
  exit 0
fi

if [ "$(id -un)" != sub2api ]; then
  echo "Certificate publication must run as sub2api" >&2
  exit 1
fi
uid=$(id -u)
export XDG_RUNTIME_DIR="/run/user/$uid"
umask 077
volume=$(podman volume inspect --format '{{.Mountpoint}}' sub2api_caddy_data)
directory="$volume/origin-certificates"
mkdir -p "$directory"
exec 9>"$directory/.deploy.lock"
flock 9

pending=$(mktemp "$directory/.sub2api.pem.XXXXXX")
previous=$(mktemp "$directory/.previous.pem.XXXXXX")
trap 'rm -f "$pending" "$previous"' EXIT
cat >"$pending"
openssl x509 -in "$pending" -noout -checkhost sub2api.gapsee.com
openssl x509 -in "$pending" -noout -checkend 86400
certificate_key=$(openssl x509 -in "$pending" -pubkey -noout |
  openssl pkey -pubin -outform DER | sha256sum)
private_key=$(openssl pkey -in "$pending" -pubout -outform DER | sha256sum)
if [ "$certificate_key" != "$private_key" ]; then
  echo "Certificate and private key do not match" >&2
  exit 1
fi

certificate="$directory/sub2api.gapsee.com.pem"
if cmp -s "$pending" "$certificate"; then
  exit 0
fi
had_previous=false
if [ -e "$certificate" ]; then
  cp "$certificate" "$previous"
  had_previous=true
fi
mv "$pending" "$certificate"
if ! podman exec sub2api-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile ||
   ! podman exec sub2api-caddy caddy reload --force --config /etc/caddy/Caddyfile --adapter caddyfile; then
  if "$had_previous"; then
    mv "$previous" "$certificate"
  else
    rm -f "$certificate"
  fi
  echo "Caddy rejected the certificate; restored the previous certificate file" >&2
  exit 1
fi
