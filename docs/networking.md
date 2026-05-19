# Browser Networking

Popcorn browser sessions use WebRTC for the interactive stream. In production,
plan for TURN and direct UDP together:

- TURN gives browser users a reliable fallback when direct UDP cannot connect.
- Direct UDP lets WebRTC connect without relay when the client can reach the
  Agones GameServer port.

For most public deployments, configure TURN first. Treat direct UDP as a
performance path that depends on your cloud firewall and user network.

## Cloudflare TURN

Popcorn supports Cloudflare TURN through `browser-turn-secret`.

Create a Cloudflare Calls TURN key, then store the key ID and API token in the
browser workload namespace:

```bash
kubectl -n popcorn create secret generic browser-turn-secret \
  --from-literal=TURN_KEY_ID="$TURN_KEY_ID" \
  --from-literal=TURN_API_TOKEN="$TURN_API_TOKEN" \
  --from-literal=NEKO_ICESERVERS=""
```

Leave `NEKO_ICESERVERS` empty for the Cloudflare path. On browser pod startup,
the runtime exchanges `TURN_KEY_ID` and `TURN_API_TOKEN` for short-lived ICE
server credentials and exports them to Neko.

If you use External Secrets Operator, sync the same keys into
`browser-turn-secret` instead of creating the Kubernetes Secret directly. The
browser-fleet chart can render that ExternalSecret when
`externalSecrets.enabled=true`.

## Verify TURN

After a browser GameServer starts, check the browser runtime logs:

```bash
kubectl -n popcorn logs <browser-pod-name> -c browser-runtime --tail=200 | grep -i cloudflare
```

You should see that Cloudflare ICE servers were generated. If not, check:

- `TURN_KEY_ID` is set.
- `TURN_API_TOKEN` is set.
- the Cloudflare key is still valid.
- the browser GameServer was created after the Secret was updated.

After rotating TURN credentials, recycle existing browser GameServers so new
pods read the new Secret:

```bash
kubectl -n popcorn delete gameserver --all
```

## Static ICE Servers

If you do not use Cloudflare TURN, set `NEKO_ICESERVERS` to a static ICE server
JSON value in `browser-turn-secret`.

Example shape:

```json
[
  {
    "urls": ["turn:turn.example.com:3478"],
    "username": "user",
    "credential": "password"
  }
]
```

When `NEKO_ICESERVERS` is set, make sure it is valid JSON and that the browser
runtime can reach the TURN server.

## STUN-Only Direct UDP

Internal GKE deployments have also worked with STUN-only ICE servers when the
browser nodes are reachable on their Agones UDP ports. This avoids TURN relay
traffic, but it only works when the user's network can make a direct UDP path
to the node or GameServer address.

The setup is:

1. Configure Agones with a production-sized UDP port range.
2. Open that same UDP range on the GKE node firewall.
3. Leave `webrtc.advertiseHost` empty in GKE so the browser runtime discovers
   the node external address or GameServer address.
4. Set `NEKO_ICESERVERS` to STUN servers and leave `TURN_KEY_ID` /
   `TURN_API_TOKEN` empty.

Example Secret:

```bash
kubectl -n popcorn create secret generic browser-turn-secret \
  --from-literal=TURN_KEY_ID="" \
  --from-literal=TURN_API_TOKEN="" \
  --from-literal='NEKO_ICESERVERS=[{"urls":["stun:stun.l.google.com:19302"]}]'
```

Example Agones range:

```yaml
agones:
  install: true

agonesInstaller:
  gameservers:
    namespaces:
      - popcorn
    minPort: 59000
    maxPort: 61000
```

On GKE, add an ingress firewall rule for that UDP range to the browser node
network tags. The internal setup used a rule equivalent to:

```bash
gcloud compute firewall-rules create popcorn-browser-webrtc-udp \
  --network <vpc-name> \
  --direction INGRESS \
  --action ALLOW \
  --rules udp:59000-61000 \
  --source-ranges <client-cidr-ranges> \
  --target-tags <browser-node-network-tag>
```

Use a narrower source range than `0.0.0.0/0` when you know where users connect
from. Keep Cloudflare TURN or another TURN service configured if users may be
behind symmetric NAT, corporate firewalls, mobile networks, or UDP-blocking
networks.

## Direct Agones UDP

The browser fleet exposes a `webrtc-udp` Agones port with `portPolicy:
Passthrough`. Agones assigns a UDP host port from its configured GameServer
port range.

For production direct UDP:

1. Pick an Agones GameServer port range large enough for expected browser
   concurrency.
2. Configure Agones with that range.
3. Open that UDP range from user networks to the browser nodes or load-balancer
   path your cluster uses.
4. Keep `webrtc.advertiseHost` empty in GKE so the runtime discovers the node
   or GameServer address.
5. Keep TURN configured as fallback.

When using the bundled Agones dependency, configure the range in browser-fleet
values:

```yaml
agones:
  install: true

agonesInstaller:
  gameservers:
    namespaces:
      - popcorn
    minPort: 59000
    maxPort: 61000
```

If Agones is installed separately, configure the same range in that Agones Helm
release instead.

## Local Kind

The local Kind setup is intentionally different from production:

- Kind publishes UDP `7000-7010` from the node container.
- the local Agones install uses the same small range.
- browser fleet sets `webrtc.advertiseHost=127.0.0.1`.

That is only for same-machine testing. Do not copy the local UDP range into
production unless it is intentionally sized for your expected concurrency.

## Troubleshooting

If the browser page loads but the stream does not connect:

```bash
kubectl -n popcorn logs <browser-pod-name> -c browser-runtime --tail=200
kubectl -n popcorn get secret browser-turn-secret -o yaml
kubectl -n popcorn get gameservers -o wide
```

Common causes:

- TURN credentials are empty or invalid.
- `NEKO_ICESERVERS` is malformed.
- browser GameServers were not restarted after Secret rotation.
- cloud firewall rules do not allow the Agones UDP range.
- direct UDP is blocked by the user's network and no TURN relay is configured.
