# Popcorn Docs

Popcorn OSS v1 is a self-hostable browser platform for Kubernetes. These docs cover local deployment, Helm deployment, the session API, browser automation, security, attestation, and release practices.

## Start Here

- [README](../README.md): project overview and quickstart.
- [Local Kind deployment](local-kind.md): run Popcorn on a local Kind cluster.
- [Helm deployment](helm-deployment.md): deploy Popcorn to a Kubernetes cluster.
- [Configuration](configuration.md): chart values, deployment profiles, and optional components.
- [Secrets](secrets.md): required Kubernetes Secret names, keys, and backend-neutral management patterns.
- [Session API](api.md): create, inspect, and delete browser sessions.

## Operations

- [Security](security.md): trust boundaries, authentication, runtime isolation, and safe defaults.
- [Production hardening](production-hardening.md): production checklist for identity, network, secrets, runtime, and operations.
- [Troubleshooting](troubleshooting.md): common local, Helm, auth, browser, and CI failures.
- [Attestation](attestation.md): optional proof flow for confidential-computing deployments.
- [Images and releases](images-and-releases.md): image ownership, tags, digests, and OSS release dependencies.

## Related Projects

- [popcorn-images](../popcorn-images/README.md): separate OSS repository for browser image assets.

## OSS v1 Notes

- The AI-agent component is excluded from the OSS v1 export; it may still exist in the internal repository.
- The public showcase is docs, architecture, placeholders for screenshots or GIFs, and a local demo flow.
- There is no hosted public demo for OSS v1.
- If this repository does not include a root `LICENSE` file, OSS launch is blocked until licensing is added.
