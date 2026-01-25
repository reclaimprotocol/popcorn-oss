import { AllocationResponse } from "../types";
import { KubeConfig } from '@kubernetes/client-node';

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

            console.log(`✅ Allocated GameServer: ${status.gameServerName} at ${status.address}:${status.ports?.[0]?.port}`);

            return {
                gameServerName: status.gameServerName,
                address: status.address,
                nodeName: status.nodeName,
                ports: status.ports || []
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

            return items.map((gs: any) => ({
                name: gs.metadata.name,
                state: gs.status.state,
                address: gs.status.address,
                port: gs.status.ports?.[0]?.port,
                nodeName: gs.spec.nodeName || 'unknown'
            }));

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
