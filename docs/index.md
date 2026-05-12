# Popcorn Docs

Popcorn OSS v1 is a self-hostable browser platform for Kubernetes. These docs cover local Kind development, GCP/GKE deployment, the session API, browser automation, security, GCP attestation, and release practices.

## Start Here

- [README](../README.md): project overview and quickstart.
- [Local Kind deployment](local-kind.md): run Popcorn on a local Kind cluster.
- [GCP deployment](helm-deployment.md): deploy Popcorn to Google Kubernetes Engine.
- [Configuration](configuration.md): chart values, deployment profiles, and optional components.
- [Secrets](secrets.md): required Kubernetes Secret names, keys, and GCP Secret Manager patterns.
- [Session API](api.md): create, inspect, and delete browser sessions.

## Operations

- [Security](security.md): trust boundaries, authentication, runtime isolation, and safe defaults.
- [Production hardening](production-hardening.md): production checklist for identity, network, secrets, runtime, and operations.
- [Troubleshooting](troubleshooting.md): common local, Helm, auth, browser, and CI failures.
- [Attestation](attestation.md): optional proof flow for GCP confidential-computing deployments.
- [Images and releases](images-and-releases.md): image ownership, tags, digests, and OSS release dependencies.

## Related Projects

- [popcorn-images](../popcorn-images/README.md): separate OSS repository for browser image assets.

## OSS v1 Notes

- There is no hosted public demo for OSS v1.
- Production deployment support is GCP/GKE only for now.
- OSS sync smoke test marker: 2026-05-13.
- Rebase sync smoke test marker: 2026-05-13.
