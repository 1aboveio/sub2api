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

## Cloudflare Tunnel access

Clients use `https://sub2api.gapsee.com/v1` with their existing API keys.
No Clash client is required. After the user confirmed the pilot connection
worked, this hostname moved from nginx to Cloudflare Tunnel on 2026-10-22
at 08:08:20 UTC. `https://sub2api-cf.gapsee.com/v1` remains an alias for
the same Tunnel. The origin `https://www.gafeteria.com/v1` remains a
separate route.

Cloudflare DNS record `f5feaa51d2303191448092ccb30e1b55` in zone
`5075f3a8cc751a78fc6894c5b4968871` is now a proxied CNAME to
`837bed69-e168-4b62-aa08-ac4a5d23f8f5.cfargotunnel.com`. The previous
nginx origin, `119.28.3.34`, remains running for DNS-cache convergence
and rollback. Cached DNS answers can continue using nginx until they expire.

Google Cloud checks HTTPS `/health` every 60 seconds, validates the
certificate, and requires HTTP 200 with `"status":"ok"`:

| Hostname | Uptime check ID | Alert policy ID |
| --- | --- | --- |
| `sub2api.gapsee.com` | `sub2api-cloudflare-primary-https-ml80iLJXmJw` | `9198836564713716048` |
| `sub2api-cf.gapsee.com` | `sub2api-cloudflare-tunnel-https-7MRXfuz9fpA` | `8648292914073931986` |

Both policies use a two-minute failure window and the existing operations
notification channel. These checks monitor availability. The upload and
streaming probes below provide separate transport validation.

The request path for both hostnames is Cloudflare → `sub2api-cloudflared` →
`http://sub2api:8080` on the existing `sub2api_backend` Podman network. The Tunnel bypasses nginx
and Caddy. Application authentication still applies. The remotely managed
Tunnel ID is `837bed69-e168-4b62-aa08-ac4a5d23f8f5`.
The desired remote ingress configuration is in
[`cloudflared-config.json`](cloudflared-config.json).

The separate `sub2api-cloudflared.service` runs rootless as `sub2api` and
starts at boot after the application stack. Its runner derives the account's
runtime directory. The runner pins the Tunnel transport to HTTP/2 over TCP.
The initial QUIC transport lost a connection during the long-stream probe with
`timeout: no recent network activity`.

Deploy its files without restarting the application:

```bash
sudo install -m 755 run-cloudflared.sh /opt/sub2api/run-cloudflared.sh
sudo install -m 644 sub2api-cloudflared.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/sub2api-cloudflared.service
sudo systemctl daemon-reload
sudo systemctl enable --now sub2api-cloudflared.service
```

Before starting the unit, provision these VM-local files:

- `/opt/sub2api/cloudflared.env`: `TUNNEL_TOKEN`, mode `0600`, owned by `sub2api`.
- `/opt/sub2api/cloudflared-image.env`: `CLOUDFLARED_IMAGE`, set to an immutable
  image reference. The deployed connector uses
  `docker.io/cloudflare/cloudflared@sha256:c3f24df7c5e68c1467afc5486c155689f247eb02246b3a124fc5f42458728672`.

Check the service and public route:

```bash
sudo systemctl status sub2api-cloudflared.service
sudo journalctl -u sub2api-cloudflared.service -n 30 --no-pager
curl --fail https://sub2api-cf.gapsee.com/health
```

To roll the primary hostname back to nginx, restore DNS record
`f5feaa51d2303191448092ccb30e1b55` using
[`sub2api-dns-rollback.json`](sub2api-dns-rollback.json): an A record for
`119.28.3.34` with Cloudflare proxying disabled. Keep the Tunnel running
for clients using the alias. Verify health and an authenticated request
through the restored route after cached DNS entries expire.

To remove the Tunnel entirely, first move both hostnames to their intended
replacement routes and remove their Tunnel-specific alerts and uptime checks.
Then disable `sub2api-cloudflared.service`, delete the Tunnel, and remove
configuration rule `4fa40853149d470d828d889d61180d77` from the zone's
`http_config_settings` ruleset.

Performance must be compared from the affected clients' networks. A successful
health check alone does not validate large uploads or long streams. Browser
Integrity Check is disabled only for `/v1/` paths on the two Tunnel hostnames
because it rejected a default Python urllib user agent with error `1010`. Application
API-key authentication remains enabled.

After the primary DNS cutover, the original hostname passed authentication
checks with an existing API key and completed an 8 MiB model stream with
the expected output. Time to first text was 7.801 seconds and total duration
was 7.976 seconds. Public DNS returned Cloudflare addresses. These are
single-request validation timings, not latency guarantees.

Before the cutover on 2026-10-22, equivalent streamed `gpt-6-luna` requests
with an 8 MiB JSON body returned the expected text through all three routes. The body used JSON
whitespace padding to exercise uploads without adding prompt tokens. One
concurrent comparison from the operator's machine, with the Tunnel using
HTTP/2 transport, measured:

| Route | Time to first text | Total duration |
| --- | ---: | ---: |
| Cloudflare Tunnel | 26.815 s | 26.990 s |
| Clash CF → US → `www.gafeteria.com` | 10.113 s | 10.114 s |
| nginx relay `sub2api.gapsee.com` | 117.441 s | 117.465 s |

These are individual samples, not percentile estimates or proof of performance
from every client network. Separate authenticated transport probes verified
the SHA-256 digest of an 8 MiB upload and a 2 MiB upload deliberately spread
over 67.635 seconds. The probes use a temporary server rather than a model.
A synthetic SSE stream completed in 311.896 seconds with all 32 events and
the final completion marker. The largest gap between events was 10.430
seconds. This validates sustained transport with regular events; it does
not establish how long an entirely silent model request can wait. The
temporary probe route and server were removed after verification.

### Comparison with explicit Clash routes

Later in the pre-cutover testing on 2026-10-22, three requests per route
compared true direct access, `cf -> us`, `cf -> do`, and the Tunnel. All 12 streamed model requests
completed with the expected text. Each request used a new TLS connection,
the same `gpt-6-luna` prompt, low reasoning effort, and an 8 MiB body padded
with JSON whitespace. Each round ran one request per route concurrently.

| Route | Health first-byte median | Model first-text median | Model first-text range |
| --- | ---: | ---: | ---: |
| China ISP → `www.gafeteria.com` | 0.738 s | 11.843 s | 5.160–14.874 s |
| CF → US → `www.gafeteria.com` | 2.804 s | 10.060 s | 5.912–10.906 s |
| CF → DO → `www.gafeteria.com` | 3.239 s | 10.711 s | 10.209–17.138 s |
| China ISP → Cloudflare Tunnel → Sub2API | 1.182 s | 15.469 s | 9.755–18.436 s |

An isolated Mihomo instance copied the two named proxy definitions and used
separate loopback listeners. Its outbound sockets bound to physical interface
`en0`, with TUN disabled. Egress checks confirmed China for the direct route
and the US for both proxy routes. The active Clash configuration was unchanged.

These overlapping ranges do not establish a clear model-latency winner among
direct access, CF → US, and CF → DO. The earlier nginx relay measurements were
much slower, but were taken in a separate test. The model timings include upload,
network setup, and upstream processing; they are not pure bandwidth measurements.
