#!/bin/sh
set -eu

uid=$(id -u)
export XDG_RUNTIME_DIR="/run/user/$uid"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

attempt=0
while [ "$attempt" -lt 150 ]; do
  running=$(/usr/bin/podman ps --format '{{.Names}}' | sort | tr '\n' ' ')
  if [ "$running" = "sub2api sub2api-caddy sub2api-valkey " ]; then
    app_health=$(/usr/bin/podman inspect sub2api --format '{{.State.Health.Status}}' 2>/dev/null || true)
    valkey_health=$(/usr/bin/podman inspect sub2api-valkey --format '{{.State.Health.Status}}' 2>/dev/null || true)
    if [ "$app_health" = "healthy" ] && [ "$valkey_health" = "healthy" ]; then
      exit 0
    fi
  fi
  attempt=$((attempt + 1))
  sleep 2
done

/usr/bin/podman ps -a
exit 1
