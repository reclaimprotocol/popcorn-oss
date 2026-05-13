import importlib.util
import os
from pathlib import Path
import unittest


def load_prescaler():
    os.environ.setdefault("GCP_PROJECT", "popcorn-oss")
    os.environ.setdefault("GKE_CLUSTER", "popcorn-gke-us-central1")
    os.environ.setdefault("GKE_LOCATION", "us-central1")
    os.environ.setdefault("GKE_NODE_POOL", "popcorn-gke-us-central1-primary")

    module_path = Path(__file__).with_name("gke-node-prescaler.py")
    spec = importlib.util.spec_from_file_location("gke_node_prescaler", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


prescaler = load_prescaler()


def game_server(state="Ready"):
    return {"metadata": {}, "status": {"state": state}}


def node(zone):
    return {
        "metadata": {
            "labels": {
                "topology.kubernetes.io/zone": zone,
                "cloud.google.com/gke-nodepool": "popcorn-gke-us-central1-primary",
            }
        }
    }


def fleet(replicas=10):
    return {"spec": {"replicas": replicas}}


def fleet_autoscaler(desired=None, min_replicas=10):
    status = {}
    if desired is not None:
        status["desiredReplicas"] = desired
    return {
        "spec": {
            "policy": {
                "buffer": {
                    "minReplicas": min_replicas,
                }
            }
        },
        "status": status,
    }


NODE_POOL = {
    "locations": ["us-central1-a", "us-central1-b", "us-central1-c"],
    "autoscaling": {"maxNodeCount": 6},
}


class CalculateTargetTest(unittest.TestCase):
    def test_env_first_uses_first_non_empty_value(self):
        old_values = {name: os.environ.get(name) for name in ("ONE", "TWO", "THREE")}
        try:
            os.environ["ONE"] = ""
            os.environ["TWO"] = "  fallback-project  "
            os.environ["THREE"] = "later-project"

            self.assertEqual(prescaler.env_first(("ONE", "TWO", "THREE")), "fallback-project")
        finally:
            for name, value in old_values.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def setUp(self):
        prescaler.CONFIG.update(
            {
                "location": "us-central1",
                "node_pool": "popcorn-gke-us-central1-primary",
                "pods_per_node": 5,
                "target_sessions_per_minute": 5,
                "desired_coverage_minutes": 2,
                "burst_headroom_gameservers": 15,
                "apply_headroom_only_when_demand_above_baseline": True,
                "scale_ahead_free_slots": 4,
                "max_nodes_total": 18,
            }
        )

    def calculate(self, desired=10, live=10, pending=0, current_nodes=3, fas=None):
        nodes = [node(f"us-central1-{suffix}") for suffix in ("a", "b", "c")][:current_nodes]
        return prescaler.calculate_target(
            fleet(10),
            fas if fas is not None else fleet_autoscaler(desired),
            [game_server() for _ in range(live)],
            nodes,
            NODE_POOL,
            pending_pods=pending,
            current_nodes_total=current_nodes,
        )

    def test_uses_fleet_autoscaler_desired_replicas_as_primary_demand(self):
        target = self.calculate(desired=12, live=8)

        self.assertEqual(target["desiredReplicas"], 12)
        self.assertEqual(target["desiredReplicasSource"], "fleetAutoscalerStatus")
        self.assertEqual(target["liveGameServers"], 8)
        self.assertEqual(target["headroomGameServers"], 15)
        self.assertEqual(target["targetGameServers"], 27)
        self.assertEqual(target["targetNodesTotal"], 6)
        self.assertEqual(target["desiredNodesPerZone"], 2)

    def test_falls_back_to_fleet_replicas_when_autoscaler_status_is_missing(self):
        target = self.calculate(desired=None, live=8, fas={})

        self.assertEqual(target["desiredReplicas"], 10)
        self.assertEqual(target["desiredReplicasSource"], "fleetSpec")
        self.assertEqual(target["targetGameServers"], 10)
        self.assertFalse(target["headroomApplied"])
        self.assertFalse(target["scaleAheadApplied"])

    def test_caps_pending_pods_as_pressure_bump(self):
        target = self.calculate(desired=20, live=20, pending=10)

        self.assertEqual(target["pendingPressureBump"], 4)
        self.assertEqual(target["targetGameServers"], 39)

    def test_applies_scale_ahead_when_free_slots_are_at_threshold(self):
        prescaler.CONFIG.update(
            {
                "target_sessions_per_minute": 0,
                "burst_headroom_gameservers": 0,
            }
        )

        target = self.calculate(desired=11, live=11)

        self.assertEqual(target["freeSlotsBeforeScaleAhead"], 4)
        self.assertTrue(target["scaleAheadApplied"])
        self.assertEqual(target["targetNodesTotal"], 6)
        self.assertEqual(target["desiredNodesPerZone"], 2)

    def test_clamps_target_nodes_to_max_nodes_total(self):
        target = self.calculate(desired=150, live=150, current_nodes=18)

        self.assertEqual(target["targetGameServers"], 165)
        self.assertEqual(target["targetNodesTotal"], 18)
        self.assertEqual(target["desiredNodesPerZone"], 6)


if __name__ == "__main__":
    unittest.main()
