# Compute Engine Podman deployment

This stack runs the production application, a VM-local Valkey instance, and
Caddy on one Compute Engine VM. PostgreSQL remains on the shared private Cloud
SQL address and is not part of this compose project.

Runtime files under `/opt/sub2api`:

- `compose.env` contains the immutable application image digest.
- `runtime.env` contains Cloud Run-compatible settings and secrets fetched on
  the VM from Secret Manager. It must be mode `0600` and owned by `sub2api`.
- `compose.yaml` and `Caddyfile` come from this directory.

The stack is managed by `sub2api-compose.service`. The service runs rootless
Podman as the `sub2api` user; `run-compose.sh` derives that account's runtime
directory instead of hard-coding its UID and waits for the lingering user bus
to become ready during boot. The VM sets
`net.ipv4.ip_unprivileged_port_start` to `80` so Caddy can bind HTTP and HTTPS
without root privileges. The unit only reports a successful start after
`wait-healthy.sh` confirms the application and Valkey health checks.

All services use Podman's `k8s-file` log driver. The Google Cloud Ops Agent
configuration in `ops-agent.yaml` tails the rootless `vfs` container log files
into Cloud Logging. Update that receiver path if Podman's graph driver changes.

Useful operations:

```bash
sudo systemctl status sub2api-compose.service
sudo -u sub2api XDG_RUNTIME_DIR=/run/user/$(id -u sub2api) podman ps
sudo -u sub2api XDG_RUNTIME_DIR=/run/user/$(id -u sub2api) podman logs sub2api
sudo systemctl reload sub2api-compose.service
```

Valkey is not published on the host and initially has persistence disabled,
matching the replaced Memorystore instance. Do not enable AOF until the Redis
keyspace and restart behavior have been reviewed under production traffic.

Cloud Run and Memorystore remain rollback targets until the VM has passed the
acceptance window. Their deletion is intentionally outside this deployment.