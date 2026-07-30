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


def game_server(state="Ready", allocated_at=None):
    annotations = {}
    if allocated_at:
        annotations["agones.dev/last-allocated"] = allocated_at
    return {"metadata": {"annotations": annotations}, "status": {"state": state}}


def pending_pod(created_at="2026-06-16T00:00:00Z", unschedulable=False):
    conditions = []
    if unschedulable:
        conditions.append(
            {
                "type": "PodScheduled",
                "status": "False",
                "reason": "Unschedulable",
            }
        )
    return {
        "metadata": {
            "creationTimestamp": created_at,
            "labels": {"agones.dev/role": "gameserver"},
        },
        "status": {
            "phase": "Pending",
            "conditions": conditions,
        },
    }


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


def fleet_autoscaler(desired=None, min_replicas=10, buffer_size=10, max_replicas=150):
    status = {}
    if desired is not None:
        status["desiredReplicas"] = desired
    return {
        "spec": {
            "policy": {
                "buffer": {
                    "bufferSize": buffer_size,
                    "minReplicas": min_replicas,
                    "maxReplicas": max_replicas,
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
                "dynamic_buffer_enabled": False,
                "dynamic_buffer_patch_fleet_autoscaler": True,
                "dynamic_buffer_min_ready_gameservers": 0,
                "dynamic_buffer_max_ready_gameservers": 0,
                "dynamic_buffer_lead_seconds": 180,
                "dynamic_buffer_allocation_window_seconds": 120,
                "dynamic_buffer_safety_margin_gameservers": 0,
                "dynamic_buffer_scale_down_delay_seconds": 900,
                "dynamic_buffer_decay_step_gameservers": 5,
                "dynamic_buffer_latency_derived_enabled": False,
                "dynamic_buffer_trend_window_seconds": 600,
                "dynamic_buffer_protection_seconds": 162,
                "dynamic_buffer_rounding_gameservers": 5,
                "dynamic_buffer_planned_rate_per_minute": 0.0,
                "dynamic_buffer_planned_rate_burst_multiplier": 1.1,
                "dynamic_buffer_decay_interval_seconds": 60,
                "scale_ahead_free_slots": 4,
                "max_nodes_total": 18,
                "node_step": 1,
                "emergency_node_step": 2,
                "lookahead_seconds": 90,
                "scale_up_cooldown_seconds": 30,
                "cooldown_bypass_pending_pods": 1,
                "cooldown_bypass_oldest_pending_seconds": 20,
                "inflight_resize_grace_seconds": 180,
            }
        )
        prescaler.DEMAND_HISTORY.clear()
        prescaler.RESIZE_STATE.clear()
        prescaler.BUFFER_STATE.clear()
        prescaler.METRIC_GAUGES.clear()
        prescaler.METRIC_COUNTERS.clear()

    def calculate(
        self,
        desired=10,
        live=10,
        pending=0,
        current_nodes=3,
        fas=None,
        demand_history=None,
        gameservers=None,
        buffer_state=None,
        now=None,
    ):
        nodes = [node(f"us-central1-{suffix}") for suffix in ("a", "b", "c")][:current_nodes]
        return prescaler.calculate_target(
            fleet(10),
            fas if fas is not None else fleet_autoscaler(desired),
            gameservers if gameservers is not None else [game_server() for _ in range(live)],
            nodes,
            NODE_POOL,
            pending_pods=pending,
            current_nodes_total=current_nodes,
            demand_history=demand_history,
            now=now,
            buffer_state=buffer_state,
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

    def test_ignores_transient_live_gameserver_churn_as_demand(self):
        target = self.calculate(desired=10, live=15, current_nodes=4)

        self.assertEqual(target["desiredReplicas"], 10)
        self.assertEqual(target["liveGameServers"], 15)
        self.assertEqual(target["demandGameServers"], 10)
        self.assertEqual(target["headroomGameServers"], 0)
        self.assertFalse(target["headroomApplied"])
        self.assertEqual(target["targetGameServers"], 10)
        self.assertEqual(target["targetNodesTotal"], 2)

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

    def test_normal_scale_up_is_limited_by_node_step(self):
        target = self.calculate(desired=50, live=50, current_nodes=6)

        decision = prescaler.plan_scale_request(target, current_nodes_total=6, now=100, last_scale_at=0)

        self.assertEqual(decision["action"], "resize")
        self.assertEqual(decision["mode"], "normal")
        self.assertEqual(decision["observedNodesPerZone"], 2)
        self.assertEqual(decision["fullDesiredNodesPerZone"], 5)
        self.assertEqual(decision["requestedNodesPerZone"], 3)

    def test_emergency_scale_up_uses_emergency_step(self):
        target = self.calculate(desired=50, live=50, pending=2, current_nodes=6)
        target["unschedulableBrowserPods"] = 1

        decision = prescaler.plan_scale_request(target, current_nodes_total=6, now=100, last_scale_at=0)

        self.assertEqual(decision["action"], "resize")
        self.assertEqual(decision["mode"], "emergency")
        self.assertIn("unschedulable_pending_pods", decision["reasons"])
        self.assertEqual(decision["requestedNodesPerZone"], 4)

    def test_cooldown_blocks_normal_scale_up(self):
        target = self.calculate(desired=50, live=50, current_nodes=6)

        decision = prescaler.plan_scale_request(target, current_nodes_total=6, now=100, last_scale_at=90)

        self.assertEqual(decision["action"], "skip_cooldown")
        self.assertEqual(decision["reason"], "scale_up_cooldown")
        self.assertGreater(decision["cooldownRemainingSeconds"], 0)

    def test_emergency_scale_up_bypasses_cooldown(self):
        target = self.calculate(desired=50, live=50, pending=2, current_nodes=6)
        target["unschedulableBrowserPods"] = 1

        decision = prescaler.plan_scale_request(target, current_nodes_total=6, now=100, last_scale_at=90)

        self.assertEqual(decision["action"], "resize")
        self.assertEqual(decision["mode"], "emergency")
        self.assertTrue(decision["cooldownBypassed"])

    def test_duplicate_resize_is_suppressed_while_inflight(self):
        target = self.calculate(desired=40, live=40, current_nodes=6)
        resize_state = {
            "requestedAt": 90,
            "requestedNodesPerZone": 4,
            "requestedNodesTotal": 12,
        }

        decision = prescaler.plan_scale_request(
            target,
            current_nodes_total=6,
            now=100,
            last_scale_at=90,
            resize_state=resize_state,
        )

        self.assertEqual(decision["action"], "skip_duplicate")
        self.assertTrue(decision["inflightResizeActive"])
        self.assertEqual(decision["requestedNodesPerZone"], 4)

    def test_higher_demand_can_raise_inflight_resize_target(self):
        target = self.calculate(desired=65, live=65, current_nodes=6)
        resize_state = {
            "requestedAt": 90,
            "requestedNodesPerZone": 4,
            "requestedNodesTotal": 12,
        }

        decision = prescaler.plan_scale_request(
            target,
            current_nodes_total=6,
            now=100,
            last_scale_at=0,
            resize_state=resize_state,
        )

        self.assertEqual(decision["action"], "resize")
        self.assertEqual(decision["basisNodesPerZone"], 4)
        self.assertEqual(decision["requestedNodesPerZone"], 5)

    def test_predictive_lookahead_increases_target_when_demand_rises(self):
        history = []
        self.calculate(desired=20, live=20, current_nodes=6, demand_history=history, now=100)
        target = self.calculate(desired=30, live=30, current_nodes=6, demand_history=history, now=130)

        self.assertEqual(target["demandGrowthPerMinute"], 20.0)
        self.assertEqual(target["lookaheadGameServers"], 30)
        self.assertEqual(target["targetGameServers"], 75)

    def test_dynamic_buffer_increases_from_recent_allocations(self):
        prescaler.CONFIG.update(
            {
                "dynamic_buffer_enabled": True,
                "dynamic_buffer_min_ready_gameservers": 10,
                "dynamic_buffer_max_ready_gameservers": 60,
                "dynamic_buffer_lead_seconds": 180,
                "dynamic_buffer_allocation_window_seconds": 120,
                "dynamic_buffer_safety_margin_gameservers": 5,
                "burst_headroom_gameservers": 0,
            }
        )
        gameservers = [
            game_server("Allocated", allocated_at="2026-06-16T00:00:30Z")
            for _ in range(10)
        ] + [game_server() for _ in range(10)]
        now = prescaler.datetime(2026, 6, 16, 0, 1, 0, tzinfo=prescaler.timezone.utc).timestamp()

        target = self.calculate(
            desired=20,
            live=20,
            current_nodes=6,
            gameservers=gameservers,
            now=now,
        )

        self.assertEqual(target["allocationRatePerMinute"], 5.0)
        self.assertEqual(target["dynamicBufferLoadGameServers"], 15)
        self.assertEqual(target["desiredReadyBufferGameServers"], 30)
        self.assertEqual(target["desiredFleetAutoscalerMinReplicas"], 30)
        self.assertEqual(target["estimatedActiveSessions"], 10)
        self.assertEqual(target["targetFleetReplicas"], 40)
        self.assertEqual(target["targetGameServers"], 40)
        self.assertTrue(target["dynamicBufferPatchRequired"])

    def test_dynamic_buffer_holds_before_idle_delay_then_decays(self):
        prescaler.CONFIG.update(
            {
                "dynamic_buffer_enabled": True,
                "dynamic_buffer_min_ready_gameservers": 10,
                "dynamic_buffer_scale_down_delay_seconds": 900,
                "dynamic_buffer_decay_step_gameservers": 5,
                "burst_headroom_gameservers": 0,
            }
        )
        buffer_spec = {"bufferSize": 40, "minReplicas": 40, "maxReplicas": 150}
        buffer_state = {"lastLoadAt": 100.0}

        held = prescaler.calculate_dynamic_buffer(
            buffer_spec,
            [game_server() for _ in range(10)],
            demand_game_server_count=10,
            baseline_gameservers=10,
            buffer_state=buffer_state,
            now=500,
        )
        decayed = prescaler.calculate_dynamic_buffer(
            buffer_spec,
            [game_server() for _ in range(10)],
            demand_game_server_count=10,
            baseline_gameservers=10,
            buffer_state=buffer_state,
            now=1100,
        )

        self.assertEqual(held["desiredReadyBufferGameServers"], 40)
        self.assertEqual(held["desiredFleetAutoscalerMinReplicas"], 40)
        self.assertFalse(held["dynamicBufferPatchRequired"])
        self.assertEqual(decayed["desiredReadyBufferGameServers"], 35)
        self.assertEqual(decayed["desiredFleetAutoscalerMinReplicas"], 35)
        self.assertTrue(decayed["dynamicBufferPatchRequired"])

    def test_dynamic_buffer_respects_configured_max(self):
        prescaler.CONFIG.update(
            {
                "dynamic_buffer_enabled": True,
                "dynamic_buffer_min_ready_gameservers": 10,
                "dynamic_buffer_max_ready_gameservers": 20,
                "dynamic_buffer_lead_seconds": 180,
                "dynamic_buffer_allocation_window_seconds": 120,
                "dynamic_buffer_safety_margin_gameservers": 5,
                "burst_headroom_gameservers": 0,
            }
        )
        gameservers = [
            game_server("Allocated", allocated_at="2026-06-16T00:00:30Z")
            for _ in range(20)
        ]
        now = prescaler.datetime(2026, 6, 16, 0, 1, 0, tzinfo=prescaler.timezone.utc).timestamp()

        target = self.calculate(desired=30, live=20, gameservers=gameservers, now=now)

        self.assertEqual(target["desiredReadyBufferGameServers"], 20)
        self.assertEqual(target["dynamicBufferMaxGameServers"], 20)

    def test_latency_derived_buffer_uses_measured_protection_budget(self):
        prescaler.CONFIG.update(
            {
                "dynamic_buffer_enabled": True,
                "dynamic_buffer_latency_derived_enabled": True,
                "dynamic_buffer_min_ready_gameservers": 10,
                "dynamic_buffer_max_ready_gameservers": 150,
                "dynamic_buffer_allocation_window_seconds": 120,
                "dynamic_buffer_trend_window_seconds": 600,
                "dynamic_buffer_protection_seconds": 162,
                "dynamic_buffer_rounding_gameservers": 5,
                "burst_headroom_gameservers": 0,
            }
        )
        gameservers = [
            game_server("Allocated", allocated_at="2026-06-16T00:00:30Z")
            for _ in range(36)
        ]
        now = prescaler.datetime(2026, 6, 16, 0, 1, 0, tzinfo=prescaler.timezone.utc).timestamp()

        target = self.calculate(
            desired=46,
            live=36,
            current_nodes=9,
            gameservers=gameservers,
            buffer_state={},
            now=now,
        )

        self.assertEqual(target["dynamicBufferStrategy"], "latency-derived")
        self.assertEqual(target["allocationRatePerMinute"], 18.0)
        self.assertEqual(target["trendAllocationRatePerMinute"], 18.0)
        self.assertEqual(target["effectiveAllocationRatePerMinute"], 18.0)
        self.assertEqual(target["desiredReadyBufferGameServers"], 50)
        self.assertEqual(target["dynamicBufferProtectionSeconds"], 162)

    def test_latency_derived_buffer_uses_planned_rate_with_burst_margin(self):
        prescaler.CONFIG.update(
            {
                "dynamic_buffer_enabled": True,
                "dynamic_buffer_latency_derived_enabled": True,
                "dynamic_buffer_min_ready_gameservers": 10,
                "dynamic_buffer_max_ready_gameservers": 150,
                "dynamic_buffer_planned_rate_per_minute": 20.0,
                "dynamic_buffer_planned_rate_burst_multiplier": 1.1,
                "dynamic_buffer_protection_seconds": 162,
                "dynamic_buffer_rounding_gameservers": 5,
            }
        )

        result = prescaler.calculate_dynamic_buffer(
            {"bufferSize": 10, "minReplicas": 10, "maxReplicas": 150},
            [game_server() for _ in range(10)],
            demand_game_server_count=10,
            baseline_gameservers=10,
            buffer_state={},
            now=100,
        )

        self.assertEqual(result["plannedAllocationRatePerMinute"], 20.0)
        self.assertEqual(result["effectiveAllocationRatePerMinute"], 22.0)
        self.assertEqual(result["desiredReadyBufferGameServers"], 60)

    def test_latency_derived_buffer_holds_and_decays_on_wall_clock_interval(self):
        prescaler.CONFIG.update(
            {
                "dynamic_buffer_enabled": True,
                "dynamic_buffer_latency_derived_enabled": True,
                "dynamic_buffer_min_ready_gameservers": 10,
                "dynamic_buffer_scale_down_delay_seconds": 900,
                "dynamic_buffer_decay_step_gameservers": 5,
                "dynamic_buffer_decay_interval_seconds": 60,
            }
        )
        buffer_spec = {"bufferSize": 40, "minReplicas": 40, "maxReplicas": 150}
        buffer_state = {
            "lastRateAt": 0.0,
            "trendAllocationRatePerMinute": 0.0,
        }

        held = prescaler.calculate_dynamic_buffer(
            buffer_spec,
            [],
            demand_game_server_count=10,
            baseline_gameservers=10,
            buffer_state=buffer_state,
            now=100,
        )
        first_decay = prescaler.calculate_dynamic_buffer(
            buffer_spec,
            [],
            demand_game_server_count=10,
            baseline_gameservers=10,
            buffer_state=buffer_state,
            now=1000,
        )
        reconcile_too_soon = prescaler.calculate_dynamic_buffer(
            {"bufferSize": 35, "minReplicas": 35, "maxReplicas": 150},
            [],
            demand_game_server_count=10,
            baseline_gameservers=10,
            buffer_state=buffer_state,
            now=1005,
        )
        second_decay = prescaler.calculate_dynamic_buffer(
            {"bufferSize": 35, "minReplicas": 35, "maxReplicas": 150},
            [],
            demand_game_server_count=10,
            baseline_gameservers=10,
            buffer_state=buffer_state,
            now=1060,
        )

        self.assertEqual(held["desiredReadyBufferGameServers"], 40)
        self.assertEqual(first_decay["desiredReadyBufferGameServers"], 35)
        self.assertEqual(reconcile_too_soon["desiredReadyBufferGameServers"], 35)
        self.assertEqual(second_decay["desiredReadyBufferGameServers"], 30)

    def test_dynamic_buffer_uses_configured_baseline_when_live_min_replicas_is_high(self):
        prescaler.CONFIG.update(
            {
                "dynamic_buffer_enabled": True,
                "dynamic_buffer_min_ready_gameservers": 10,
                "burst_headroom_gameservers": 0,
            }
        )

        target = self.calculate(
            desired=40,
            live=40,
            fas=fleet_autoscaler(desired=40, min_replicas=40, buffer_size=40),
        )

        self.assertEqual(target["baselineGameServers"], 10)
        self.assertEqual(target["currentFleetAutoscalerMinReplicas"], 40)
        self.assertEqual(target["targetFleetReplicas"], 40)

    def test_browser_pod_pressure_counts_unschedulable_and_oldest_pending(self):
        pressure = prescaler.browser_pod_pressure(
            [pending_pod("2026-06-16T00:00:00Z", unschedulable=True)],
            now=prescaler.datetime(2026, 6, 16, 0, 0, 45, tzinfo=prescaler.timezone.utc).timestamp(),
        )

        self.assertEqual(pressure["pending"], 1)
        self.assertEqual(pressure["unschedulable"], 1)
        self.assertEqual(pressure["oldestPendingSeconds"], 45)

    def test_metrics_renderer_exposes_expected_values(self):
        target = self.calculate(desired=12, live=8)
        target["gameServerStates"] = {"Ready": 8}
        decision = prescaler.plan_scale_request(target, current_nodes_total=3, now=100, last_scale_at=0)

        prescaler.update_metrics(target, current_nodes_total=3, decision=decision, reconcile_duration_seconds=0.25)
        rendered = prescaler.render_metrics()

        self.assertIn("popcorn_prescaler_current_nodes_total 3", rendered)
        self.assertIn('popcorn_prescaler_gameservers{state="Ready"} 8', rendered)
        self.assertIn("popcorn_prescaler_effective_allocation_rate_per_minute 0", rendered)
        self.assertIn("popcorn_prescaler_dynamic_buffer_protection_seconds 162", rendered)
        self.assertIn("popcorn_prescaler_reconcile_duration_seconds 0.25", rendered)


if __name__ == "__main__":
    unittest.main()
