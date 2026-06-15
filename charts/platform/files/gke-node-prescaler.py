import json
import math
import os
import ssl
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

K8S_HOST = os.environ.get("KUBERNETES_SERVICE_HOST", "kubernetes.default.svc")
K8S_PORT = os.environ.get("KUBERNETES_SERVICE_PORT", "443")
K8S_API = f"https://{K8S_HOST}:{K8S_PORT}"
K8S_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token"
K8S_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"

DEMAND_HISTORY = []
RESIZE_STATE = {}
DECISION_COUNTER = 0
METRIC_GAUGES = {}
METRIC_COUNTERS = {}


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


def env_first(names):
    for name in names:
        raw = os.environ.get(name)
        if raw is not None and raw.strip() != "":
            return raw.strip()
    raise RuntimeError(f"one of {', '.join(names)} must be set")


CONFIG = {
    "project": env_first(("GCP_PROJECT", "GOOGLE_CLOUD_PROJECT", "PROJECT_ID")),
    "cluster": os.environ["GKE_CLUSTER"],
    "location": os.environ["GKE_LOCATION"],
    "node_pool": os.environ["GKE_NODE_POOL"],
    "namespace": os.environ.get("NAMESPACE", "default"),
    "fleet": os.environ.get("FLEET_NAME", "browser-fleet"),
    "fleet_autoscaler": os.environ.get("FLEET_AUTOSCALER_NAME", "browser-autoscaler"),
    "interval_seconds": env_int("INTERVAL_SECONDS", 15),
    "pods_per_node": env_int("PODS_PER_NODE", 4),
    "node_step": env_int("NODE_STEP", 1),
    "emergency_node_step": env_int("EMERGENCY_NODE_STEP", 2),
    "lookahead_seconds": env_int("LOOKAHEAD_SECONDS", 90),
    "target_sessions_per_minute": env_int("TARGET_SESSIONS_PER_MINUTE", 5),
    "desired_coverage_minutes": env_int("DESIRED_COVERAGE_MINUTES", 2),
    "burst_headroom_gameservers": env_int("BURST_HEADROOM_GAMESERVERS", 0),
    "apply_headroom_only_when_demand_above_baseline": env_bool("APPLY_HEADROOM_ONLY_WHEN_DEMAND_ABOVE_BASELINE", True),
    "scale_ahead_free_slots": env_int("SCALE_AHEAD_FREE_SLOTS", 4),
    "max_nodes_total": env_int("MAX_NODES_TOTAL", 0),
    "scale_up_cooldown_seconds": env_int("SCALE_UP_COOLDOWN_SECONDS", 60),
    "cooldown_bypass_pending_pods": env_int("COOLDOWN_BYPASS_PENDING_PODS", 1),
    "cooldown_bypass_oldest_pending_seconds": env_int("COOLDOWN_BYPASS_OLDEST_PENDING_SECONDS", 20),
    "inflight_resize_grace_seconds": env_int("INFLIGHT_RESIZE_GRACE_SECONDS", 180),
    "metrics_enabled": env_bool("METRICS_ENABLED", True),
    "metrics_port": env_int("METRICS_PORT", 9102),
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


def ready_gameserver_count(items):
    return sum(
        1
        for item in active_items(items)
        if item.get("status", {}).get("state") == "Ready"
    )


def is_browser_gameserver_pod(pod):
    labels = pod.get("metadata", {}).get("labels", {})
    return labels.get("agones.dev/role") == "gameserver"


def parse_k8s_timestamp_seconds(raw, now=None):
    if not raw:
        return None
    if now is None:
        now = time.time()
    try:
        timestamp = raw
        if timestamp.endswith("Z"):
            timestamp = f"{timestamp[:-1]}+00:00"
        parsed = datetime.fromisoformat(timestamp)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return max(0.0, now - parsed.timestamp())
    except ValueError:
        return None


def pod_is_unschedulable(pod):
    conditions = pod.get("status", {}).get("conditions", [])
    for condition in conditions:
        if condition.get("type") != "PodScheduled":
            continue
        if condition.get("status") == "False" and condition.get("reason") == "Unschedulable":
            return True
    return False


def browser_pod_pressure(pods, now=None):
    if now is None:
        now = time.time()
    pending = 0
    unschedulable = 0
    oldest_pending = 0.0

    for pod in active_items(pods):
        if not is_browser_gameserver_pod(pod):
            continue
        if pod.get("status", {}).get("phase") != "Pending":
            continue

        pending += 1
        if pod_is_unschedulable(pod):
            unschedulable += 1
        age = parse_k8s_timestamp_seconds(
            pod.get("metadata", {}).get("creationTimestamp"),
            now=now,
        )
        if age is not None:
            oldest_pending = max(oldest_pending, age)

    return {
        "pending": pending,
        "unschedulable": unschedulable,
        "oldestPendingSeconds": oldest_pending,
    }


def browser_pending_pods(pods):
    return browser_pod_pressure(pods)["pending"]


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


def append_demand_history(history, now, demand):
    history.append({"ts": now, "demand": demand})
    window_seconds = max(120, CONFIG["lookahead_seconds"] * 2)
    oldest_allowed = now - window_seconds
    while len(history) > 1 and history[0]["ts"] < oldest_allowed:
        history.pop(0)


def demand_growth_per_minute(history, now, current_demand):
    if len(history) < 2:
        return 0.0

    oldest = history[0]
    elapsed = max(0.0, now - oldest["ts"])
    if elapsed <= 0:
        return 0.0

    growth = current_demand - int(oldest["demand"])
    return max(0.0, (growth / elapsed) * 60.0)


def calculate_target(
    fleet,
    fleet_autoscaler,
    gameservers,
    nodes,
    node_pool,
    pending_pods=0,
    current_nodes_total=None,
    demand_history=None,
    now=None,
    unschedulable_pods=0,
    oldest_pending_pod_seconds=0,
):
    if now is None:
        now = time.time()

    autoscaler_status = fleet_autoscaler.get("status", {})
    autoscaler_spec = fleet_autoscaler.get("spec", {})
    buffer_spec = autoscaler_spec.get("policy", {}).get("buffer", {})
    desired_replicas = autoscaler_status.get("desiredReplicas")
    desired_replicas_source = "fleetAutoscalerStatus"
    if desired_replicas is None:
        desired_replicas = fleet.get("spec", {}).get("replicas", 0)
        desired_replicas_source = "fleetSpec"

    live_gameservers = len(demand_relevant_gameservers(gameservers))
    free_ready_gameservers = ready_gameserver_count(gameservers)
    # FleetAutoscaler desired replicas track real session demand plus buffer.
    # Live GameServers can temporarily spike during Agones replacement churn and
    # should not be treated as user demand.
    demand_game_server_count = int(desired_replicas or 0)
    baseline_gameservers = int(buffer_spec.get("minReplicas") or fleet.get("spec", {}).get("replicas") or 0)

    configured_headroom = CONFIG["burst_headroom_gameservers"]
    if configured_headroom <= 0:
        configured_headroom = CONFIG["target_sessions_per_minute"] * CONFIG["desired_coverage_minutes"]

    apply_headroom = True
    if CONFIG["apply_headroom_only_when_demand_above_baseline"]:
        apply_headroom = demand_game_server_count > baseline_gameservers

    growth_per_minute = 0.0
    lookahead_gameservers = 0
    if demand_history is not None:
        append_demand_history(demand_history, now, demand_game_server_count)
        growth_per_minute = demand_growth_per_minute(demand_history, now, demand_game_server_count)
        lookahead_gameservers = math.ceil(growth_per_minute * CONFIG["lookahead_seconds"] / 60.0)

    headroom = configured_headroom if apply_headroom else 0
    scale_ahead_free_slots = max(0, CONFIG["scale_ahead_free_slots"])
    pending_pressure_bump = min(max(0, int(pending_pods or 0)), scale_ahead_free_slots)
    target_gameservers = demand_game_server_count + headroom + lookahead_gameservers + pending_pressure_bump

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
        "freeReadyGameServers": free_ready_gameservers,
        "baselineGameServers": baseline_gameservers,
        "demandGameServers": demand_game_server_count,
        "headroomGameServers": headroom,
        "demandGrowthPerMinute": round(growth_per_minute, 3),
        "lookaheadSeconds": CONFIG["lookahead_seconds"],
        "lookaheadGameServers": lookahead_gameservers,
        "pendingPressureBump": pending_pressure_bump,
        "pendingBrowserPods": int(pending_pods or 0),
        "unschedulableBrowserPods": int(unschedulable_pods or 0),
        "oldestPendingPodSeconds": round(float(oldest_pending_pod_seconds or 0), 3),
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


def observed_nodes_per_zone(current_nodes_total, zone_count):
    return math.ceil(current_nodes_total / max(1, zone_count))


def active_inflight_resize(resize_state, current_nodes_total, now):
    if not resize_state:
        return None

    requested_at = float(resize_state.get("requestedAt", 0))
    requested_total = int(resize_state.get("requestedNodesTotal", 0))
    if requested_at <= 0 or requested_total <= 0:
        return None
    if now - requested_at > CONFIG["inflight_resize_grace_seconds"]:
        return None
    if current_nodes_total >= requested_total:
        return None
    return resize_state


def emergency_reasons(target):
    reasons = []
    pending_threshold = max(0, CONFIG["cooldown_bypass_pending_pods"])
    oldest_pending_threshold = max(0, CONFIG["cooldown_bypass_oldest_pending_seconds"])

    if pending_threshold > 0 and target["unschedulableBrowserPods"] >= pending_threshold:
        reasons.append("unschedulable_pending_pods")
    if oldest_pending_threshold > 0 and target["oldestPendingPodSeconds"] >= oldest_pending_threshold:
        reasons.append("oldest_pending_pod")
    if target["freeReadyGameServers"] <= 0 and target["demandGameServers"] > target["baselineGameServers"]:
        reasons.append("no_ready_gameserver_capacity")

    return reasons


def plan_scale_request(target, current_nodes_total, now, last_scale_at, resize_state=None):
    zone_count = target["zoneCount"]
    observed_per_zone = observed_nodes_per_zone(current_nodes_total, zone_count)
    full_desired_per_zone = target["desiredNodesPerZone"]
    full_desired_total = full_desired_per_zone * zone_count
    inflight = active_inflight_resize(resize_state or {}, current_nodes_total, now)
    inflight_per_zone = int(inflight.get("requestedNodesPerZone", 0)) if inflight else 0
    basis_per_zone = max(observed_per_zone, inflight_per_zone)
    reasons = emergency_reasons(target)
    mode = "emergency" if reasons else "normal"
    cooldown_remaining = 0.0

    decision = {
        "action": "none",
        "mode": mode,
        "reason": "capacity_sufficient",
        "reasons": reasons,
        "observedNodesPerZone": observed_per_zone,
        "basisNodesPerZone": basis_per_zone,
        "fullDesiredNodesPerZone": full_desired_per_zone,
        "fullDesiredNodesTotal": full_desired_total,
        "requestedNodesPerZone": observed_per_zone,
        "requestedNodesTotal": current_nodes_total,
        "cooldownRemainingSeconds": 0.0,
        "cooldownBypassed": False,
        "inflightResizeActive": bool(inflight),
        "inflightRequestedNodesPerZone": inflight_per_zone,
    }

    if target["targetNodesTotal"] <= current_nodes_total or full_desired_per_zone <= observed_per_zone:
        return decision

    if full_desired_per_zone <= basis_per_zone:
        decision.update(
            {
                "action": "skip_duplicate",
                "reason": "resize_already_inflight",
                "requestedNodesPerZone": basis_per_zone,
                "requestedNodesTotal": basis_per_zone * zone_count,
            }
        )
        return decision

    if last_scale_at > 0:
        cooldown_remaining = CONFIG["scale_up_cooldown_seconds"] - (now - last_scale_at)
        if mode != "emergency" and cooldown_remaining > 0:
            decision.update(
                {
                    "action": "skip_cooldown",
                    "reason": "scale_up_cooldown",
                    "cooldownRemainingSeconds": round(cooldown_remaining, 3),
                }
            )
            return decision

    step = max(1, CONFIG["emergency_node_step"] if mode == "emergency" else CONFIG["node_step"])
    requested_per_zone = min(full_desired_per_zone, basis_per_zone + step)
    decision.update(
        {
            "action": "resize",
            "reason": ",".join(reasons) if reasons else "target_above_capacity",
            "requestedNodesPerZone": requested_per_zone,
            "requestedNodesTotal": requested_per_zone * zone_count,
            "cooldownBypassed": mode == "emergency" and last_scale_at > 0 and cooldown_remaining > 0,
        }
    )
    return decision


def metric_key(name, labels=None):
    label_items = tuple(sorted((labels or {}).items()))
    return name, label_items


def set_gauge(name, value, labels=None):
    METRIC_GAUGES[metric_key(name, labels)] = float(value)


def inc_counter(name, amount=1, labels=None):
    key = metric_key(name, labels)
    METRIC_COUNTERS[key] = METRIC_COUNTERS.get(key, 0.0) + float(amount)


def format_metric_labels(labels):
    if not labels:
        return ""
    rendered = ",".join(f'{key}="{str(value).replace(chr(34), chr(92) + chr(34))}"' for key, value in labels)
    return f"{{{rendered}}}"


def render_metrics():
    lines = []
    for (name, labels), value in sorted(METRIC_GAUGES.items()):
        lines.append(f"{name}{format_metric_labels(labels)} {value:g}")
    for (name, labels), value in sorted(METRIC_COUNTERS.items()):
        lines.append(f"{name}{format_metric_labels(labels)} {value:g}")
    return "\n".join(lines) + "\n"


def update_metrics(target, current_nodes_total, decision, reconcile_duration_seconds):
    set_gauge("popcorn_prescaler_current_nodes_total", current_nodes_total)
    set_gauge("popcorn_prescaler_target_nodes_total", target["targetNodesTotal"])
    set_gauge("popcorn_prescaler_observed_nodes_per_zone", decision["observedNodesPerZone"])
    set_gauge("popcorn_prescaler_requested_nodes_per_zone", decision["requestedNodesPerZone"])
    set_gauge("popcorn_prescaler_fleet_desired_replicas", int(target["desiredReplicas"] or 0))
    set_gauge("popcorn_prescaler_pending_pods_total", target["pendingBrowserPods"])
    set_gauge("popcorn_prescaler_unschedulable_pods_total", target["unschedulableBrowserPods"])
    set_gauge("popcorn_prescaler_oldest_pending_pod_seconds", target["oldestPendingPodSeconds"])
    set_gauge("popcorn_prescaler_free_ready_gameservers", target["freeReadyGameServers"])
    set_gauge("popcorn_prescaler_reconcile_duration_seconds", reconcile_duration_seconds)
    for state, count in target.get("gameServerStates", {}).items():
        set_gauge("popcorn_prescaler_gameservers", count, {"state": state})


class MetricsHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/metrics":
            self.send_response(404)
            self.end_headers()
            return
        body = render_metrics().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *args):
        return


def start_metrics_server():
    if not CONFIG["metrics_enabled"]:
        return None
    server = ThreadingHTTPServer(("0.0.0.0", CONFIG["metrics_port"]), MetricsHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    log("info", "started prescaler metrics endpoint", port=CONFIG["metrics_port"])
    return server


def next_decision_id(now):
    global DECISION_COUNTER
    DECISION_COUNTER += 1
    return f"{int(now * 1000)}-{DECISION_COUNTER}"


def reconcile(last_scale_at):
    start = time.time()
    now = start
    decision_id = next_decision_id(now)
    namespace = CONFIG["namespace"]
    fleet = k8s_get(api_path("fleet", CONFIG["fleet"]))
    fleet_autoscaler = k8s_get_optional(api_path("fleetautoscaler", CONFIG["fleet_autoscaler"])) or {}
    gameservers = k8s_get(api_path("gameservers")).get("items", [])
    pods = k8s_get(api_path("pods")).get("items", [])
    nodes = k8s_get(api_path("nodes")).get("items", [])
    node_pool = gcp_get(nodepool_path())

    pool_nodes = nodes_for_pool(nodes)
    current_nodes_total = len(pool_nodes)
    pod_pressure = browser_pod_pressure(pods, now=now)
    target = calculate_target(
        fleet,
        fleet_autoscaler,
        gameservers,
        pool_nodes,
        node_pool,
        pod_pressure["pending"],
        current_nodes_total,
        demand_history=DEMAND_HISTORY,
        now=now,
        unschedulable_pods=pod_pressure["unschedulable"],
        oldest_pending_pod_seconds=pod_pressure["oldestPendingSeconds"],
    )
    gs_counts = state_counts(active_items(gameservers))
    target["gameServerStates"] = gs_counts
    decision = plan_scale_request(target, current_nodes_total, now, last_scale_at, RESIZE_STATE)

    fields = {
        "decisionId": decision_id,
        "namespace": namespace,
        "fleet": CONFIG["fleet"],
        "currentNodesTotal": current_nodes_total,
        "gameServerStates": gs_counts,
        "fleetAutoscalerFound": bool(fleet_autoscaler),
        **target,
        **decision,
    }

    if decision["action"] == "none":
        log("info", "node capacity is sufficient", **fields)
    elif decision["action"] == "skip_duplicate":
        inc_counter("popcorn_prescaler_duplicate_resize_skips_total")
        log("info", "scale-up skipped because resize is already in flight", **fields)
    elif decision["action"] == "skip_cooldown":
        inc_counter("popcorn_prescaler_cooldown_skips_total")
        log("info", "scale-up skipped during cooldown", **fields)
    elif decision["action"] == "resize":
        if decision["cooldownBypassed"]:
            inc_counter("popcorn_prescaler_cooldown_bypasses_total")

        if CONFIG["dry_run"]:
            log("info", "dry-run would resize node pool", **fields)
        else:
            operation = gcp_post(f"{nodepool_path()}:setSize", {"nodeCount": decision["requestedNodesPerZone"]})
            fields["operation"] = operation.get("name")
            log("info", "requested node pool resize", **fields)

        inc_counter(
            "popcorn_prescaler_scale_requests_total",
            labels={"mode": decision["mode"], "reason": decision["reason"]},
        )
        RESIZE_STATE.update(
            {
                "requestedAt": now,
                "requestedNodesPerZone": decision["requestedNodesPerZone"],
                "requestedNodesTotal": decision["requestedNodesTotal"],
                "mode": decision["mode"],
                "reason": decision["reason"],
            }
        )
        last_scale_at = now

    active_resize = active_inflight_resize(RESIZE_STATE, current_nodes_total, now)
    if not active_resize and RESIZE_STATE.get("requestedAt"):
        observed_seconds = max(0.0, now - float(RESIZE_STATE["requestedAt"]))
        set_gauge("popcorn_prescaler_resize_to_node_observed_seconds", observed_seconds)
        RESIZE_STATE.clear()

    update_metrics(target, current_nodes_total, decision, time.time() - start)
    return last_scale_at


def main():
    required = ["project", "cluster", "location", "node_pool"]
    missing = [name for name in required if not CONFIG[name]]
    if missing:
        raise RuntimeError(f"missing required config: {', '.join(missing)}")

    start_metrics_server()
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
