import { AllocationResponse } from "../types";
import { KubeConfig } from '@kubernetes/client-node';
import { K8s } from "./k8s";

const kc = new KubeConfig();
try {
    kc.loadFromDefault();
} catch (e) {
    console.warn("⚠️ Failed to load KubeConfig");
}

export const Agones = {
    async allocate(namespace: string = "default", fleetName: string = "browser-fleet"): Promise<AllocationResponse> {
        console.log(`🎮 Requesting allocation via K8s API [${fleetName}]...`);

        try {
            const cluster = kc.getCurrentCluster();
            if (!cluster) throw new Error("No K8s cluster config");

            const url = `${cluster.server}/apis/allocation.agones.dev/v1/namespaces/${namespace}/gameserverallocations`;

            const body = {
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

            const opts: any = {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            };

            await kc.applyToFetchOptions(opts);

            // Bun/Node TLS handling
            if (cluster.skipTLSVerify || process.env.NODE_TLS_REJECT_UNAUTHORIZED == "0") {
                // @ts-ignore
                opts.tls = { rejectUnauthorized: false };
            }

            const res = await fetch(url, opts as any);

            if (!res.ok) {
                const txt = await res.text();
                throw new Error(`K8s allocation failed ${res.status}: ${txt}`);
            }

            const json = await res.json() as any;
            const status = json.status;

            if (status.state !== "Allocated") {
                throw new Error(`GameServerAllocation failed state: ${status.state}`);
            }

            console.log(`✅ Allocated GameServer: ${status.gameServerName}. Fetching Pod IP...`);

            // 6. Fetch Pod IP (Internal) because we use portPolicy: None
            // We retry a few times because the Pod IP might take a split second if it was just spinning up (though usually ready)
            let podIp: string | null = null;
            for (let i = 0; i < 5; i++) {
                podIp = await K8s.getGameServerPodIP(status.gameServerName);
                if (podIp) break;
                await new Promise(r => setTimeout(r, 500));
            }

            if (!podIp) {
                console.warn(`⚠️ Could not resolve Pod IP for ${status.gameServerName}, falling back to NodeAddress which might be wrong for None policy.`);
                podIp = status.address; // Fallback
            }

            console.log(`📌 Resolved Pod IP: ${podIp}`);

            return {
                gameServerName: status.gameServerName,
                address: podIp!, // Use Pod IP internally
                nodeName: status.nodeName,
                // Return internal ports as we don't have host ports
                ports: [
                    { name: "http", port: 8082, protocol: "TCP" },
                    { name: "cdp", port: 9222, protocol: "TCP" },
                    { name: "kernel-api", port: 10001, protocol: "TCP" }
                ]
            };
        } catch (e) {
            console.error("❌ Agones allocation error:", e);
            throw e;
        }
    },

    async listGameServers(namespace: string = "default") {
        try {
            const cluster = kc.getCurrentCluster();
            if (!cluster) {
                console.error("❌ No cluster in KubeConfig");
                return [];
            }

            const url = `${cluster.server}/apis/agones.dev/v1/namespaces/${namespace}/gameservers`;
            const opts: any = { method: "GET", headers: {} };

            await kc.applyToFetchOptions(opts);

            if (cluster.skipTLSVerify || process.env.NODE_TLS_REJECT_UNAUTHORIZED == "0") {
                // @ts-ignore
                opts.tls = { rejectUnauthorized: false };
            }

            const res = await fetch(url, opts as any);
            if (!res.ok) {
                const txt = await res.text();
                console.error(`❌ Agones list failed ${res.status}: ${txt}`);
                return [];
            }

            const json = await res.json() as any;
            const items = json.items || [];

            // Fetch all pods to map IPs (since Agones reports Node IP)
            const pods = await K8s.listBrowserPods();
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

    async shutdownGameServer(name: string, namespace: string = "default") {
        console.log(`💀 Deleting GameServer: ${name}`);
        try {
            const cluster = kc.getCurrentCluster();
            if (!cluster) throw new Error("No K8s cluster config");

            const url = `${cluster.server}/apis/agones.dev/v1/namespaces/${namespace}/gameservers/${name}`;
            const opts: any = { method: "DELETE", headers: {} };

            await kc.applyToFetchOptions(opts);

            if (cluster.skipTLSVerify || process.env.NODE_TLS_REJECT_UNAUTHORIZED == "0") {
                // @ts-ignore
                opts.tls = { rejectUnauthorized: false };
            }

            const res = await fetch(url, opts as any);
            if (!res.ok && res.status !== 404) {
                const txt = await res.text();
                console.error(`❌ GameServer Delete failed ${res.status}: ${txt}`);
            } else {
                console.log(`✅ GameServer ${name} shutdown signaled.`);
            }
        } catch (e) {
            console.error(`❌ Failed to shutdown GameServer ${name}:`, e);
        }
    }
}
