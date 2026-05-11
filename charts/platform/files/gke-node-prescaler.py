import json
import math
import os
import ssl
import time
import urllib.error
import urllib.request

K8S_HOST = os.environ.get("KUBERNETES_SERVICE_HOST", "kubernetes.default.svc")
K8S_PORT = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
K8S_API = f"https://{K8S_HOST}:{K8S_PORT}"
K8S_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
K8S_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"


def env_int(name, default):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return int(raw)


def env_bool(name, default):
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return raw.lower() in ("1", "true", "yes", "on")


CONFIG = {
    "project": os.environ["GCP_PROJECT"],
    "cluster": os.environ["GKE_CLUSTER"],
    "location": os.environ["GKE_LOCATION"],
    "node_pool": os.environ["GKE_NODE_POOL"],
    "namespace": os.environ.get("NAMESPACE", "default"),
    "fleet": os.environ.get("FLEET_NAME", "browser-fleet"),
    "fleet_autoscaler": os.environ.get("FLEET_AUTOSCALER_NAME", "browser-autoscaler"),
    "interval_seconds": env_int("INTERVAL_SECONDS", 15),
    "pods_per_node": env_int("PODS_PER_NODE", 4),
    "target_sessions_per_minute": env_int("TARGET_SESSIONS_PER_MINUTE", 5),
    "desired_coverage_minutes": env_int("DESIRED_COVERAGE_MINUTES", 2),
    "burst_headroom_gameservers": env_int("BURST_HEADROOM_GAMESERVERS", 0),
    "apply_headroom_only_when_demand_above_baseline": env_bool("APPLY_HEADROOM_ONLY_WHEN_DEMAND_ABOVE_BASELINE", True),
    "scale_ahead_free_slots": env_int("SCALE_AHEAD_FREE_SLOTS", 4),
    "max_nodes_total": env_int("MAX_NODES_TOTAL", 0),
    "scale_up_cooldown_seconds": env_int("SCALE_UP_COOLDOWN_SECONDS", 60),
    "dry_run": env_bool("DRY_RUN", False),
}


def log(level, message, **fields):
    payload = {
        "level": level,
        "message": message,
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **fields,
    }
    print(json.dumps(payload, separators=(",", ":")), flush=True)


def request_json(url, method="GET", headers=None, body=None, context=None, timeout=20):
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, context=context, timeout=timeout) as resp:
            raw = resp.read()
            if not raw:
                return {}
            return json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed {exc.code}: {details}") from exc


def k8s_context():
    return ssl.create_default_context(cafile=K8S_CA_PATH)


def k8s_get(path):
    with open(K8S_TOKEN_PATH, "r", encoding="utf-8") as token_file:
        token = token_file.read().strip()
    return request_json(
        f"{K8S_API}{path}",
        headers={"Authorization": f"Bearer {token}"},
        context=k8s_context(),
    )


def k8s_get_optional(path):
    try:
        return k8s_get(path)
    except RuntimeError as exc:
        if "failed 404:" in str(exc):
            return None
        raise


def metadata_token():
    token = request_json(
        METADATA_TOKEN_URL,
        headers={"Metadata-Flavor": "Google"},
        timeout=5,
    )
    return token["access_token"]


def gcp_get(path):
    token = metadata_token()
    return request_json(
        f"https://container.googleapis.com/v1/{path}",
        headers={"Authorization": f"Bearer {token}"},
    )


def gcp_post(path, body):
    token = metadata_token()
    return request_json(
        f"https://container.googleapis.com/v1/{path}",
        method="POST",
        headers={"Authorization": f"Bearer {token}"},
        body=body,
    )


def api_path(kind, name=None):
    namespace = CONFIG["namespace"]
    if kind == "fleet":
        return f"/apis/agones.dev/v1/namespaces/{namespace}/fleets/{name}"
    if kind == "fleetautoscaler":
        return f"/apis/autoscaling.agones.dev/v1/namespaces/{namespace}/fleetautoscalers/{name}"
    if kind == "gameservers":
        return f"/apis/agones.dev/v1/namespaces/{namespace}/gameservers"
    if kind == "pods":
        return f"/api/v1/namespaces/{namespace}/pods"
    if kind == "nodes":
        return "/api/v1/nodes"
    raise ValueError(kind)


def active_items(items):
    return [item for item in items if not item.get("metadata", {}).get("deletionTimestamp")]


def demand_relevant_gameservers(items):
    ignored_states = {"Shutdown", "Unhealthy"}
    return [
        item for item in active_items(items)
        if item.get("status", {}).get("state") not in ignored_states
    ]


def state_counts(items):
    counts = {}
    for item in items:
        state = item.get("status", {}).get("state") or item.get("status", {}).get("phase") or "Unknown"
        counts[state] = counts.get(state, 0) + 1
    return counts


def browser_pending_pods(pods):
    pending = 0
    for pod in active_items(pods):
        labels = pod.get("metadata", {}).get("labels", {})
        if labels.get("agones.dev/role") != "gameserver":
            continue
        if pod.get("status", {}).get("phase") == "Pending":
            pending += 1
    return pending


def nodes_for_pool(nodes):
    active_nodes = active_items(nodes)
    pool_nodes = [
        node for node in active_nodes
        if node.get("metadata", {}).get("labels", {}).get("cloud.google.com/gke-nodepool") == CONFIG["node_pool"]
    ]
    return pool_nodes or active_nodes


def node_zones(nodes):
    zones = {
        node.get("metadata", {}).get("labels", {}).get("topology.kubernetes.io/zone")
        for node in active_items(nodes)
    }
    return sorted(zone for zone in zones if zone)


def nodepool_path():
    return (
        f"projects/{CONFIG['project']}/locations/{CONFIG['location']}/clusters/"
        f"{CONFIG['cluster']}/nodePools/{CONFIG['node_pool']}"
    )


def calculate_target(fleet, fleet_autoscaler, gameservers, nodes, node_pool, pending_pods=0, current_nodes_total=None):
    autoscaler_status = fleet_autoscaler.get("status", {})
    autoscaler_spec = fleet_autoscaler.get("spec", {})
    buffer_spec = autoscaler_spec.get("policy", {}).get("buffer", {})
    desired_replicas = autoscaler_status.get("desiredReplicas")
    desired_replicas_source = "fleetAutoscalerStatus"
    if desired_replicas is None:
        desired_replicas = fleet.get("spec", {}).get("replicas", 0)
        desired_replicas_source = "fleetSpec"

    live_gameservers = len(demand_relevant_gameservers(gameservers))
    demand_game_server_count = max(int(desired_replicas or 0), live_gameservers)
    baseline_gameservers = int(buffer_spec.get("minReplicas") or fleet.get("spec", {}).get("replicas") or 0)

    configured_headroom = CONFIG["burst_headroom_gameservers"]
    if configured_headroom <= 0:
        configured_headroom = CONFIG["target_sessions_per_minute"] * CONFIG["desired_coverage_minutes"]

    apply_headroom = True
    if CONFIG["apply_headroom_only_when_demand_above_baseline"]:
        apply_headroom = demand_game_server_count > baseline_gameservers

    headroom = configured_headroom if apply_headroom else 0
    scale_ahead_free_slots = max(0, CONFIG["scale_ahead_free_slots"])
    pending_pressure_bump = min(max(0, int(pending_pods or 0)), scale_ahead_free_slots)
    target_gameservers = demand_game_server_count + headroom + pending_pressure_bump

    node_locations = node_pool.get("locations") or node_zones(nodes) or [CONFIG["location"]]
    zone_count = max(1, len(node_locations))
    target_nodes_total = math.ceil(target_gameservers / CONFIG["pods_per_node"])

    if current_nodes_total is None:
        current_nodes_total = len(nodes)
    free_slots = (current_nodes_total * CONFIG["pods_per_node"]) - target_gameservers
    scale_ahead_applied = False
    if scale_ahead_free_slots > 0 and free_slots <= scale_ahead_free_slots:
        target_nodes_total = max(target_nodes_total, current_nodes_total + zone_count)
        scale_ahead_applied = True

    autoscaling = node_pool.get("autoscaling", {})
    max_nodes_total = CONFIG["max_nodes_total"]
    if max_nodes_total <= 0 and autoscaling.get("maxNodeCount"):
        max_nodes_total = int(autoscaling["maxNodeCount"]) * zone_count
    if max_nodes_total > 0:
        target_nodes_total = min(target_nodes_total, max_nodes_total)

    desired_per_zone = math.ceil(target_nodes_total / zone_count)
    if autoscaling.get("maxNodeCount"):
        desired_per_zone = min(desired_per_zone, int(autoscaling["maxNodeCount"]))

    return {
        "desiredReplicas": desired_replicas,
        "desiredReplicasSource": desired_replicas_source,
        "liveGameServers": live_gameservers,
        "baselineGameServers": baseline_gameservers,
        "headroomGameServers": headroom,
        "pendingPressureBump": pending_pressure_bump,
        "targetGameServers": target_gameservers,
        "targetNodesTotal": target_nodes_total,
        "desiredNodesPerZone": desired_per_zone,
        "zoneCount": zone_count,
        "nodePoolMaxNodesTotal": max_nodes_total,
        "freeSlotsBeforeScaleAhead": free_slots,
        "scaleAheadFreeSlots": scale_ahead_free_slots,
        "scaleAheadApplied": scale_ahead_applied,
        "headroomApplied": apply_headroom,
    }


def reconcile(last_scale_at):
    namespace = CONFIG["namespace"]
    fleet = k8s_get(api_path("fleet", CONFIG["fleet"]))
    fleet_autoscaler = k8s_get_optional(api_path("fleetautoscaler", CONFIG["fleet_autoscaler"])) or {}
    gameservers = k8s_get(api_path("gameservers")).get("items", [])
    pods = k8s_get(api_path("pods")).get("items", [])
    nodes = k8s_get(api_path("nodes")).get("items", [])
    node_pool = gcp_get(nodepool_path())

    pool_nodes = nodes_for_pool(nodes)
    current_nodes_total = len(pool_nodes)
    pending_pods = browser_pending_pods(pods)
    target = calculate_target(fleet, fleet_autoscaler, gameservers, pool_nodes, node_pool, pending_pods, current_nodes_total)
    gs_counts = state_counts(active_items(gameservers))

    fields = {
        "namespace": namespace,
        "fleet": CONFIG["fleet"],
        "currentNodesTotal": current_nodes_total,
        "pendingBrowserPods": pending_pods,
        "gameServerStates": gs_counts,
        "fleetAutoscalerFound": bool(fleet_autoscaler),
        **target,
    }

    if target["targetNodesTotal"] <= current_nodes_total:
        log("info", "node capacity is sufficient", **fields)
        return last_scale_at

    now = time.time()
    cooldown_remaining = CONFIG["scale_up_cooldown_seconds"] - (now - last_scale_at)
    if last_scale_at > 0 and cooldown_remaining > 0:
        log("info", "scale-up skipped during cooldown", cooldownRemainingSeconds=round(cooldown_remaining, 1), **fields)
        return last_scale_at

    if CONFIG["dry_run"]:
        log("info", "dry-run would resize node pool", **fields)
        return now

    operation = gcp_post(f"{nodepool_path()}:setSize", {"nodeCount": target["desiredNodesPerZone"]})
    log("info", "requested node pool resize", operation=operation.get("name"), **fields)
    return now


def main():
    required = ["project", "cluster", "location", "node_pool"]
    missing = [name for name in required if not CONFIG[name]]
    if missing:
        raise RuntimeError(f"missing required config: {', '.join(missing)}")

    log("info", "starting GKE node pre-scaler", config=CONFIG)
    last_scale_at = 0.0
    while True:
        try:
            last_scale_at = reconcile(last_scale_at)
        except Exception as exc:
            log("error", "reconcile failed", error=str(exc))
        time.sleep(CONFIG["interval_seconds"])


if __name__ == "__main__":
    main()
