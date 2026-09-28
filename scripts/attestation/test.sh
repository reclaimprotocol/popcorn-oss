#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# Unit tests only. MOCK launcher and TEST-JWKS fixtures never contact GCP.
(cd images/minimal-vnc-desktop/proxy && go test ./...)
(cd services/attestor && go test ./...)
(cd services/mcp-server && bun install --frozen-lockfile && bun run test)
node --test scripts/attestation/*.test.mjs
