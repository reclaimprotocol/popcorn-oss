import { AllocationResponse } from "../types";
import { KubeConfig } from '@kubernetes/client-node';
import { RuntimeConfig } from "../config";
import { K8s } from "./k8s";
import { buildK8sFetchRequest, getK8sClusterServer } from "./k8s-fetch";
import { retry } from "./retry";

const kc = new KubeConfig();
const EXTRA_ROUTE_PORTS = readExtraRoutePorts(process.env.POOL_MANAGER_SESSION_EXTENSION_ROUTE_PORTS);
try {
    kc.loadFromDefault();
} catch (e) {
    console.warn("⚠️ Failed to load KubeConfig");
}

function readExtraRoutePorts(raw: string | undefined): Array<{ name: string; port: number; protocol: string }> {
    if (!raw?.trim()) {
        return [];
    }

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            console.warn("Ignoring POOL_MANAGER_SESSION_EXTENSION_ROUTE_PORTS because it is not a JSON object");
            return [];
        }

        return Object.entries(parsed).flatMap(([name, value]) => {
            const port = value && typeof value === "object" && !Array.isArray(value)
                ? Number((value as any).port)
                : NaN;

            if (/^[A-Za-z0-9_-]+$/.test(name) && Number.isInteger(port) && port > 0 && port <= 65535) {
                return [{ name, port, protocol: "TCP" }];
            }
            return [];
        });
    } catch (e) {
        console.warn("Ignoring POOL_MANAGER_SESSION_EXTENSION_ROUTE_PORTS because it is invalid JSON:", e);
        return [];
    }
}

export function staticInternalPorts() {
    return [
        { name: "novnc", port: 6080, protocol: "TCP" },
        { name: "cdp", port: 9222, protocol: "TCP" },
        ...EXTRA_ROUTE_PORTS,
    ];
}

async function agonesFetch(path: string, opts: any = {}) {
    const requestInit = await buildK8sFetchRequest(kc, opts);
    return fetch(`${getK8sClusterServer(kc)}${path}`, requestInit as any);
}

export const Agones = {
    async allocate(namespace: string = RuntimeConfig.gameServerNamespace, fleetName: string = RuntimeConfig.gameServerFleet, sessionId?: string): Promise<AllocationResponse> {
        console.log(`🎮 Requesting allocation via K8s API [${fleetName}]...`);

        try {
            const body: any = {
                apiVersion: "allocation.agones.dev/v1",
                kind: "GameServerAllocation",
                spec: {
                    required: {
                        matchLabels: {
                            "agones.dev/fleet": fleetName
                        }
                    }
                }
            };

            // Add session ID as metadata if provided
            if (sessionId) {
                body.spec.metadata = {
                    labels: {
                        "popcorn.dev/session-id": sessionId
                    },
                    annotations: {
                        "popcorn.dev/session-id": sessionId
                    }
                };
                console.log(`📝 Adding session metadata to allocation:`, JSON.stringify(body.spec.metadata));
            }

            const opts: any = {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            };
            const res = await agonesFetch(`/apis/allocation.agones.dev/v1/namespaces/${namespace}/gameserverallocations`, opts);

            if (!res.ok) {
                const txt = await res.text();
                throw new Error(`K8s allocation failed ${res.status}: ${txt}`);
            }

            const json = await res.json() as any;
            const status = json.status;

            // Log the full allocation response for debugging
            console.log(`📊 Allocation response:`, JSON.stringify(json, null, 2));

            if (status.state !== "Allocated") {
                console.error(`❌ Full allocation response when failed:`, JSON.stringify(json, null, 2));
                throw new Error(`GameServerAllocation failed state: ${status.state}`);
            }

            console.log(`✅ Allocated GameServer: ${status.gameServerName}. Fetching Pod IP...`);

            // Add session ID annotation to the GameServer (if provided)
            if (sessionId) {
                try {
                    await K8s.patchGameServer(namespace, status.gameServerName, {
                        metadata: {
                            annotations: {
                                "popcorn.dev/session-id": sessionId
                            }
                        }
                    });
                    console.log(`📝 Added session annotation to GameServer: ${status.gameServerName}`);
                } catch (e) {
                    console.error(`❌ Failed to add session annotation:`, e);
                }
            }

            // 6. Fetch Pod IP (Internal) because we use portPolicy: None
            // We retry a few times because the Pod IP might take a split second if it was just spinning up (though usually ready)
            const podIp = await retry(
                () => K8s.getGameServerPodIP(status.gameServerName, namespace),
                {
                    attempts: 5,
                    delayMs: 500,
                    shouldRetryResult: (value) => !value,
                },
            );

            if (!podIp) {
                console.warn(`⚠️ Could not resolve Pod IP for ${status.gameServerName}, falling back to NodeAddress which might be wrong for None policy.`);
                return {
                    gameServerName: status.gameServerName,
                    address: status.address,
                    nodeName: status.nodeName,
                    ports: staticInternalPorts()
                };
            }

            console.log(`📌 Resolved Pod IP: ${podIp}`);

            return {
                gameServerName: status.gameServerName,
                address: podIp!, // Use Pod IP internally
                nodeName: status.nodeName,
                // Return internal ports as we don't have host ports
                ports: staticInternalPorts()
            };
        } catch (e) {
            console.error("❌ Agones allocation error:", e);
            throw e;
        }
    },

    async listGameServers(namespace: string = RuntimeConfig.gameServerNamespace) {
        try {
            const res = await agonesFetch(`/apis/agones.dev/v1/namespaces/${namespace}/gameservers`, { method: "GET" });
            if (!res.ok) {
                const txt = await res.text();
                console.error(`❌ Agones list failed ${res.status}: ${txt}`);
                return [];
            }

            const json = await res.json() as any;
            const items = json.items || [];

            // Fetch all pods to map IPs (since Agones reports Node IP)
            const pods = await K8s.listBrowserPods(namespace);
            const podMap = new Map(pods.map((p: any) => [p.name, p.ip]));

            return items.map((gs: any) => {
                const podIp = podMap.get(gs.metadata.name);
                // console.log(`🔍 Debug: Mapping GS ${gs.metadata.name} -> Pod IP: ${podIp || 'NONE'}`);
                return {
                    name: gs.metadata.name,
                    state: gs.status.state,
                    address: podIp || gs.status.address, // Prefer Pod IP
                    port: gs.status.ports?.[0]?.port,
                    nodeName: gs.spec.nodeName || 'unknown'
                };
            });

        } catch (e) {
            console.error("❌ Failed to list GameServers:", e);
            return [];
        }
    },

    async shutdownGameServer(name: string, namespace: string = RuntimeConfig.gameServerNamespace) {
        console.log(`💀 Deleting GameServer: ${name}`);
        try {
            const res = await agonesFetch(`/apis/agones.dev/v1/namespaces/${namespace}/gameservers/${name}`, {
                method: "DELETE",
            });
            if (!res.ok && res.status !== 404) {
                const txt = await res.text();
                throw new Error(`GameServer delete failed ${res.status}: ${txt}`);
            }
            console.log(`✅ GameServer ${name} shutdown signaled.`);
        } catch (e) {
            console.error(`❌ Failed to shutdown GameServer ${name}:`, e);
            throw e;
        }
    }
}
