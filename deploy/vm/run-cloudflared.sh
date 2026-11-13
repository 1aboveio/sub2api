#!/bin/sh
set -eu

uid=$(id -u)
export XDG_RUNTIME_DIR="/run/user/$uid"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

if [ "${1:-}" = stop ]; then
  exec /usr/bin/podman stop --time 20 sub2api-cloudflared
fi

: "${CLOUDFLARED_IMAGE:?CLOUDFLARED_IMAGE is required}"

exec /usr/bin/podman run --rm --name sub2api-cloudflared \
  --network sub2api_backend \
  --env-file /opt/sub2api/cloudflared.env \
  --security-opt no-new-privileges \
  --cap-drop ALL \
  --read-only \
  --log-driver k8s-file \
  "$CLOUDFLARED_IMAGE" tunnel --no-autoupdate --protocol http2 run
