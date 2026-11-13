#!/bin/sh
set -eu

uid=$(id -u)
export XDG_RUNTIME_DIR="/run/user/$uid"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"

attempt=0
while { [ ! -w "$XDG_RUNTIME_DIR" ] || [ ! -S "$XDG_RUNTIME_DIR/bus" ]; }; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then
    echo "Podman user runtime is not ready: $XDG_RUNTIME_DIR" >&2
    exit 1
  fi
  sleep 1
done

exec /usr/bin/podman-compose -f /opt/sub2api/compose.yaml "$@"
