# Popcorn Docs

Popcorn is a self-hostable browser runtime platform for Kubernetes. It starts
ephemeral Chromium sessions, routes browser/CDP/API traffic through a gateway,
and lets clients create sessions through the control plane.

These docs are organized for operators who want to run Popcorn themselves.

## Understand How It Works

- [Architecture](architecture.md): how the platform works end to end — services, the
  session lifecycle, the token model, state, and trust boundaries.
- [The Popcorn Browser](popcorn-browser.md): the browser runtime that runs in each session
  pod — build, boot, ports, engine, and configuration.

## Read This First

1. [Quickstart](quickstart.md): run Popcorn locally with Kind.
2. [Deployment](deployment.md): deploy the supported production shape on GKE.
3. [GKE IP-only deployment](gke-ip-only-deployment.md): smoke-test GKE
   self-hosting before DNS and managed certificates are ready.
4. [Configuration](configuration.md): understand required and optional settings.
5. [Secrets](secrets.md): create the Kubernetes Secrets Popcorn expects.
6. [Reference](reference.md): session API, gateway paths, and config index.

## Operate It

- [Operations](operations.md): validate, upgrade, scale, and run optional services.
- [High availability](high-availability.md): run multi-zone gateway and Redis,
  migrate from singleton Redis, and validate failover.
- [Security](security.md): practical self-hosting security model and hardening.
- [Browser networking](networking.md): how the browser streams to clients over VNC / live view through the gateway.
- [Observability](observability.md): backend-neutral OpenTelemetry log and session lifecycle export.
- [Troubleshooting](troubleshooting.md): diagnose local, Helm, auth, and browser issues.

## Optional Areas

- [Attestation](attestation.md): GCP confidential-computing proof flow.
- [Images and releases](images-and-releases.md): images, tags, digests, and release inputs.

## Repository Map

| Path | Purpose |
| --- | --- |
| `charts/platform` | Gateway, pool manager, Redis, control plane, transitional bundled Postgres, TTL controller, and optional operations services. |
| `charts/browser-fleet` | Agones browser Fleet, browser runtime, live-view (VNC) streaming, autoscaler, and optional attestor. |
| `services/*` | Source for platform services. |
| `popcorn-images` | Browser image assets and runtime image build inputs. |
| `examples/helm` | Starting values for production-style GKE installs. |
| `examples/kubernetes` | Secret bootstrap examples. |

## What Runs In A Normal Install

```mermaid
flowchart LR
    client["Client or user"] --> control["Control plane"]
    control --> pool["Pool manager"]
    pool --> agones["Agones"]
    agones --> browser["Browser GameServer"]
    client --> gateway["Gateway"]
    gateway --> browser
    pool --> redis[("Redis")]
    control --> pg[("Postgres")]
```

The gateway is the only service that normally needs to be public. The control
plane can be public if clients create sessions directly, but protect its admin
surface carefully.
