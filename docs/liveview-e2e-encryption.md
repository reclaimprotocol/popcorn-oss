# LiveView end-to-end encryption

Noise E2EE covers the user-facing RFB and control connections. The gateway
forwards encrypted WebSocket frames and observes connection metadata, frame
sizes, and timing. The client and pod decrypt the message contents. Redis
stores session-to-pod route metadata.

Authenticated WSS protects CDP traffic in transit. Authenticated HTTPS protects
session status and TTL requests in transit. The gateway terminates TLS and
processes both. A server holding a valid CDP token can inspect and control the
browser, as required by CDP.

## Viewer and mode selection

Both modes use `images/minimal-vnc-desktop/viewer.js`. They share the noVNC UI,
keyboard and IME code, touch handling, quality controls, diagnostics, and
reconnect logic. The query flag selects the transport:

- the default viewer URL uses the default RFB and control routes;
- `encryption=e2e`: use the Noise RFB and encrypted control routes.

The viewer bundle contains both transport adapters. The create response points
to the same `liveview.html` in either mode.

Session requests default to the standard transport. Set `liveViewEncryption`
to `e2e` to allocate an encrypted LiveView session:

```json
{
  "sessionId": "demo",
  "regions": ["local"],
  "liveViewEncryption": "e2e"
}
```

The control plane generates two random 32-byte values for each allocation. The
enrollment secret binds the first client key. The session key names the browser's
stored reconnect record. The control plane sends only the SHA-256 hash of the
enrollment secret to the pool and pod. It returns the raw secret once, in the
authenticated create response.

The viewer generates an X25519 keypair and sends the enrollment secret inside
the encrypted Noise IK payload. The pod checks the hash and binds the first
valid client public key. Later RFB and control connections must use that key.
Recreating a deleted `sessionId` produces a new session key, enrollment secret,
and client key.

Keys and enrollment values use unpadded base64url for exactly 32 raw bytes. The
standard viewer stores the bootstrap response and client key in same-origin
`localStorage` so it can reconnect. This storage holds plaintext. Any script
running on the viewer origin can read it. Restrict the viewer origin to trusted
scripts.

The create-response URL carries bootstrap metadata in its fragment. The browser
keeps fragments client-side. After storing the reconnect record, the viewer
removes the fragment from browser history. Keep the enrollment secret in the
create-response fragment and encrypted Noise enrollment payload.

At startup, the browser proxy generates an X25519 keypair and keeps the private
key in process memory. It publishes `e2e-public-key` and `e2e-version: "1"`
through the local Agones SDK. The allocator reads them as
`agones.dev/sdk-e2e-public-key` and `agones.dev/sdk-e2e-version`.

The pool manager writes the session ID and enrollment-secret hash to the
GameServer annotations `popcorn.dev/session-id` and
`popcorn.dev/e2e-binding-secret-hash`. It reads the pod public key and pod UID
from Kubernetes, then saves that binding with the session. Redis, Kubernetes
annotations, control-plane records, and logs store hashes or public binding
data. The create response carries the raw enrollment secret to the viewer. The
viewer and pod process hold their own private keys.

The browser proxy enforces the mode inside the pod. Once it sees an E2E binding,
it rejects plaintext RFB and user-facing control requests for the rest of the
process lifetime. Those paths stay closed after an Agones SDK disconnect.
Static viewer files, both Noise endpoints, and the separate CDP ports stay
available.

## Session response

An E2EE response contains:

```json
{
  "cdpUrl": "wss://gateway/cdp/<session>/<restricted-token>/",
  "cdpInternalUrl": "wss://gateway/cdp-internal/<session>/<internal-token>/",
  "liveViewE2e": {
    "version": 1,
    "protocol": "Noise_IK_25519_ChaChaPoly_SHA256",
    "bindingSecret": "base64url-raw-32-byte-one-time-enrollment-secret",
    "podPublicKey": "base64url-raw-32-byte-x25519-public-key",
    "podUid": "kubernetes-pod-uid",
    "e2eRfbUrl": "wss://gateway/liveview-e2e-rfb/<session>/<route-token>",
    "e2eControlUrl": "wss://gateway/liveview-e2e-control/<session>/<route-token>"
  }
}
```

The control plane releases `bindingSecret` once in the create response. Fetch
and TTL responses return the persistent session metadata. The create response
places the E2E metadata and `sessionKey` in a `#popcorn-e2e=...` fragment on
`url` and `vncUrl`.

The viewer validates the fragment and stores two records. The viewer route maps
to the allocation session key, and that session key maps to the bootstrap data
and client key. It then removes the fragment. A reload uses the route to find
the same key. A new allocation gets a different session key even if it reuses
the same `sessionId`.

`cdpUrl` and `cdpInternalUrl` remain in E2E responses. Authenticated WSS
protects these server-side connections in transit.

The viewer checks the pod static key from the session response and runs one
Noise IK handshake per RFB or control connection. The protocol name is
`Noise_IK_25519_ChaChaPoly_SHA256`.

The first enrollment message is 128 bytes because it includes the encrypted
32-byte secret. A handshake with an existing binding starts with a 96-byte
message. The responder message is 48 bytes.

The prologue contains these exact UTF-8 bytes:

```text
popcorn-liveview/v1\0<sessionId>\0<podUid>\0<channel>
```

Each `\0` is one NUL byte. The final byte belongs to `<channel>`. `podUid` is a
public transcript-binding value. The pod checks the enrollment hash and either
binds the client static key or verifies the existing binding. Every connection
uses new Noise ephemeral keys.

`e2eRfbUrl` carries raw RFB bytes for the framebuffer, clipboard, pointer, and
keyboard. `e2eControlUrl` replaces `/kbd`, `/input`, `/kbdstate`, `/emulate`,
`/geometry`, and the viewer diagnostic requests. Noise limits a message to
65,535 bytes. After the 16-byte AEAD tag, each plaintext fragment can contain at
most 65,519 bytes.

## Implementations

The pod uses `github.com/flynn/noise`. The browser uses pinned versions of
`@noble/curves`, `@noble/ciphers`, and `@noble/hashes`. A deterministic test
vector checks the JavaScript handshake and transport output against the Go
implementation.

This wire format uses raw Noise IK with one Noise message per WebSocket message.
The libp2p package implements an XX handshake, peer identity payloads, stream
negotiation, and libp2p framing, which defines a different wire protocol.

TTL and status calls preserve the selected mode. Reallocation keeps E2E
sessions on E2E with the same enrollment binding, and keeps default sessions on
the default transport. Select the mode when creating the session. The
pre-bound-key request remains available to x402 and custom integrations. Normal
session creation should use `liveViewEncryption`.
