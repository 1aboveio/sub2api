# Production VM deployment state

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

Cloud Run revision `sub2api-prod-00020-gfj` and Memorystore `ai-pro` remain
active for rollback. To revert, replace the Cloudflare `www` A record with the
previous DNS-only CNAME `ghs.googlehosted.com` using automatic TTL. A sustained
300-second upstream stream remains pending; authenticated completion and SSE
framing pass on both staging and production hostnames.