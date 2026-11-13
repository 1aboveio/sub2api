# Production VM deployment state

> **Superseded on 2026-10-31:** production now runs on DigitalOcean Droplet
> `sub2api-prod-sfo3` (`24.199.126.176`), including local PostgreSQL 17 and Valkey.
> The current app is official Sub2API **0.2.19**, upgraded on 2026-10-31; see the
> [upgrade record](https://github.com/1aboveio/infra/blob/main/docs/migrations/sub2api-upgrade-0.2.19-2026-10-31.md).
> All four public hostnames target DigitalOcean; the old GCP VM is stopped.
> The GCP material below is
> historical recovery information. After the new deployment accepts writes,
> rollback requires migrating the current database back; restoring old DNS alone
> is unsafe. See the infrastructure repository's
> [migration record](https://github.com/1aboveio/infra/blob/main/docs/migrations/sub2api-digitalocean-2026-10-31.md).

Deployment date: 2026-09-14

## Resources

- Project: `cosmic-heaven-479306-v5`
- VM: `sub2api-prod-vm` in `us-central1-c`
- Machine: `e2-medium`, 20 GiB balanced boot disk, automatic restart enabled
- Static address: `sub2api-vm-prod-ip` (`35.206.117.176`, Standard tier)
- Runtime identity: `sub2api-vm-prod@cosmic-heaven-479306-v5.iam.gserviceaccount.com`
- Firewall tag: `sub2api-vm-prod`
- Snapshot policy: `sub2api-vm-prod-daily`, daily at 05:00 UTC, seven-day retention
- Baseline snapshot: `sub2api-prod-vm-baseline-20260914-v2`
- Application image: `us-central1-docker.pkg.dev/cosmic-heaven-479306-v5/a1/sub2api@sha256:0affe52a2f9f8c47ed0f111c84921432d74671fe0d9d8d3c0c7ee82267b8b9cc`

The service account has Artifact Registry read, logging write, and monitoring
metric write at project scope. Secret access is granted only on the four
existing Sub2API secrets used by Cloud Run.

## Network

Public ingress rules target only the VM tag:

- TCP `80`, TCP/UDP `443` from the internet
- TCP `22` allowed from IAP `35.235.240.0/20`
- TCP `22` denied from all other sources at a higher priority than the shared
  default SSH rule

Only Caddy publishes host ports. The application and Valkey are available only
on the Podman network. PostgreSQL remains on private Cloud SQL address
`10.58.0.15:5432` with `sslmode=require`.

## Caddy Origin Preparation (2026-10-28)

Caddy was prepared to serve `sub2api.gapsee.com` on the existing VM HTTPS
port. At preparation time, public DNS remained a proxied CNAME to Tunnel
`837bed69-e168-4b62-aa08-ac4a5d23f8f5`. The later primary cutover is recorded
below.

- A Let's Encrypt certificate covers `sub2api.gapsee.com` and expires on
  2027-01-26 at 14:10:34 UTC. Certbot uses DNS validation because the
  then-active Tunnel bypassed Caddy.
- Direct HTTPS validation with `--resolve` returned HTTP 200 and
  `{"status":"ok"}` with certificate verification enabled. An unauthenticated
  `/v1/models` request returned the expected HTTP 401 `API_KEY_REQUIRED`.
- Both Gafeteria HTTPS hostnames, the public Sub2API hostname, and the Tunnel
  alias remain healthy. Container start times and restart counts are unchanged.
- `certbot.timer` renews the certificate. The root-controlled deploy hook is
  `/usr/local/sbin/sub2api-deploy-caddy-certificate`.
  `sub2api-caddy-certificate.timer` independently reconciles publication daily,
  retries failures every 15 minutes, and skips Caddy reloads for unchanged PEMs.
- The zone-restricted token is stored root-only in
  `/etc/letsencrypt/cloudflare-sub2api.ini`. No account-wide key was installed.
- The pre-change Caddyfile is retained at
  `/opt/sub2api/Caddyfile.before-sub2api-origin-20261028` for rollback.

See the [origin preparation runbook](README.md#caddy-origin-hostname-preparation)
for installation and renewal validation. DNS-based renewal remains configured
after the primary cutover.

## Primary CNAME Cutover (2026-10-28)

At 16:20:30 UTC, the user-approved cutover changed only the target of
Cloudflare record `f5feaa51d2303191448092ccb30e1b55` in zone
`5075f3a8cc751a78fc6894c5b4968871`. It remains a proxied CNAME with automatic
TTL; its target is now `www.gafeteria.com`, which resolves to `35.206.117.176`.

The primary path is Cloudflare → VM public HTTPS → Caddy → Sub2API.
Clients still use `https://sub2api.gapsee.com/v1` and their existing API keys.
The Tunnel service, its primary-hostname ingress, and
`https://sub2api-cf.gapsee.com/v1` remain unchanged for rollback. No VM,
application, Caddy, firewall, TLS policy or monitoring configuration changed
for this DNS cutover.

Before cutover, 42 uncached test requests compared a temporary proxied CNAME
against the Tunnel. All succeeded. Median first-text times for three small
model requests were 3.842 s through Caddy and 3.755 s through the Tunnel;
for three 8 MiB requests they were 23.813 s and 33.415 s respectively.
These client-network samples include upload and model processing, and do
not establish a universal latency advantage. The temporary route and its
certificate were removed before cutover.

Post-cutover validation completed:

- Primary HTTPS `/health` returned HTTP 200 with `Via: 1.1 Caddy`.
- Authenticated primary model discovery returned HTTP 200 and 29 models.
- Three health requests per route, one small model stream per route, and one
  8 MiB model stream per route all succeeded on the primary and Tunnel alias.
  All four streams returned the expected output and `[DONE]` without cache hits.
- Existing hostname-based uptime checks continue to monitor the primary and
  Tunnel alias. Their notification policies were not changed.

Rollback: restore the same primary DNS record with
[`sub2api-tunnel-dns-rollback.json`](sub2api-tunnel-dns-rollback.json), retaining
Cloudflare proxying. Verify the Tunnel alias before rollback and the primary
API afterward. Do not disable Caddy or remove the Tunnel during rollback.
The [runbook](README.md#public-access-and-tunnel-rollback) describes both paths.

## Operations

Connect through IAP:

```bash
gcloud compute ssh sub2api-prod-vm \
  --project=cosmic-heaven-479306-v5 \
  --zone=us-central1-c \
  --tunnel-through-iap
```

Refresh secrets and change the pinned application image:

```bash
sudo -u sub2api /opt/sub2api/refresh-runtime-env.sh \
  us-central1-docker.pkg.dev/cosmic-heaven-479306-v5/a1/sub2api@sha256:<digest>
sudo systemctl restart sub2api-compose.service
```

## Monitoring

- Google Cloud Ops Agent collects host metrics and rootless Podman logs.
- Uptime check `sub2api-vm-prod-http` probes `http://35.206.117.176/health`.
- Uptime check `sub2api-vm-staging-https` probes
  `https://staging.gafeteria.com/health` with certificate validation.
- Uptime check `sub2api-vm-production-https` probes
  `https://www.gafeteria.com/health` with certificate validation.
- Alert policies cover uptime, CPU, memory, disk, and HTTP 5xx responses.
- Separate staging and production HTTPS failure policies alert after two
  minutes.
- Alerts use the existing operations email notification channel.

## Deployment automation

- Regional Cloud Build trigger `sub2api-prod` is disabled.
- Regional Cloud Build trigger `sub2api-dev` is disabled.
- Manual Cloud Build submissions remain available. GitHub CI and security
  workflows are separate and remain enabled.

## Validation completed

- Application and Valkey health checks pass; Caddy serves `/health` externally.
- The application image digest matches the active Cloud Run revision.
- Cloud SQL negotiated TLS 1.3 from the VM.
- Valkey read/write/delete succeeded and port `6379` is not published.
- Only Caddy publishes `80/443`; the application port `8080` is not published.
- Containers have `nofile=65536` and an explicit `nproc=15000`; the systemd
  unit inherits `LimitNPROC=65536` with no task-count cap.
- `wrk` completed 29,414 requests in 30 seconds with 700 concurrent
  connections and a 10-second timeout: zero socket errors/timeouts, about 978
  requests/second, p99 3.35 seconds, maximum 5.51 seconds.
- A full systemd stack restart recovered all three containers as healthy.
- A clean VM reboot changed the boot ID and recovered systemd, all three
  rootless containers, and external health in 69 seconds without intervention.
- The post-reboot baseline snapshot reached `READY`; a temporary 20 GiB
  balanced disk was successfully created from it and then removed.
- An authenticated `GET /v1/models` returned 24 models with HTTP 200.
- A `gpt-5.3-codex-spark` chat completion returned the exact smoke-test value
  with HTTP 200 and usage accounting; an unsupported model returned the
  expected structured HTTP 400 response.
- A real chat-completions stream returned HTTP 200 as `text/event-stream`,
  emitted five SSE data events plus `[DONE]`, preserved unbuffered proxy
  headers, and reconstructed the expected three-line response. Time to first
  byte was 2.02 seconds and total duration was 2.48 seconds.
- Cloudflare DNS resolves `staging.gafeteria.com` directly to
  `35.206.117.176`; production DNS remains unchanged.
- Caddy obtained a trusted Let's Encrypt certificate for
  `staging.gafeteria.com`, and the HTTPS health endpoint returns HTTP 200.
- Authenticated model discovery and SSE streaming passed through the staging
  hostname. A browser rendered the public home and login pages without console
  errors; the login form exposed the expected email and password controls.
- Production DNS resolves `www.gafeteria.com` directly to the VM with no CNAME
  or AAAA record. Caddy serves a trusted Let's Encrypt certificate for the
  production hostname.
- Production authenticated model discovery returned 24 models with HTTP 200.
  SSE streaming returned the expected `PROD_VM_STREAM_OK` payload and `[DONE]`
  with a 1.86-second time to first byte and 2.60-second total duration.
- A browser rendered the production home and login pages without console
  errors. Production requests appear in Cloud Logging, and no application or
  post-certificate Caddy errors were present after cutover.

## Restore procedure

1. Create a replacement boot disk from the newest `sub2api-vm-prod-daily`
   snapshot or the retained deployment baseline snapshot.
2. Create an `e2-medium` VM in `us-central1-c` on the `default` subnet with the
   `sub2api-vm-prod` tag and dedicated runtime service account.
3. Attach the reserved Standard-tier address after removing it from the failed
   VM. Keep the failed VM stopped until recovery is accepted.
4. If restoring without a usable boot snapshot, install Podman, Podman Compose,
   rootless networking packages, and Ops Agent; create the `sub2api` user with
   subordinate UID/GID ranges and enable lingering.
5. Restore this directory to `/opt/sub2api`, install the systemd unit and Ops
   Agent config, and run `refresh-runtime-env.sh` with the active image digest.
6. Start `sub2api-compose.service`; verify `/health`, Cloud SQL TLS, Valkey, and
   Cloud Logging before restoring DNS traffic.

Application business data remains in shared Cloud SQL. Valkey is deliberately
disposable, matching the replaced Memorystore persistence mode. Caddy state and
the application data volume can be rebuilt from configuration and Secret
Manager.

## Cutover status

Production DNS was cut over on 2026-09-14. Cloudflare serves DNS-only A records
for `www.gafeteria.com` and `staging.gafeteria.com`, both targeting
`35.206.117.176` with a 120-second TTL. There is no production AAAA record.

The former Cloud Run service `sub2api-prod` and Memorystore instance `ai-pro`
were retired on 2026-09-16 after Cloud Run received no post-cutover requests
and the VM remained healthy under production traffic. The managed Valkey
instance had persistence disabled, so no durable data was removed.

The previous DNS-only CNAME to `ghs.googlehosted.com` is no longer a live
rollback target. Recover the VM from the tested snapshots above, or recreate
Cloud Run and managed Valkey from the retained Artifact Registry image,
configuration, Cloud SQL database, and Secret Manager values before changing
DNS. A sustained 300-second upstream stream remains pending; authenticated
completion and SSE framing pass on both staging and production hostnames.