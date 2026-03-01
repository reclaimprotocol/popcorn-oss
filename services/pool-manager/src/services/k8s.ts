import { KubeConfig, CoreV1Api, AppsV1Api, CustomObjectsApi } from '@kubernetes/client-node';
import { Pod } from '../types';

// 🔧 FIX: Disable TLS verification globally for self-signed info (local dev)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const kc = new KubeConfig();
try {
    kc.loadFromDefault();
    // Also explicitly skip for clusters in config which helps some client versions
    kc.clusters.forEach(c => (c as any).skipTLSVerify = true);
} catch (e) {
    console.warn("⚠️ Failed to load KubeConfig (running outside cluster without config?)");
}

const k8s = kc.makeApiClient(CoreV1Api);
const k8sApps = kc.makeApiClient(AppsV1Api);
const k8sCustom = kc.makeApiClient(CustomObjectsApi);

export const K8s = {
    // ... existing methods ...
    async listGameServers() {
        try {
            // Fallback: RAW Fetch because client-node CustomObjectsApi is misbehaving
            const cluster = kc.getCurrentCluster();
            if (!cluster) {
                console.error("❌ No cluster in KubeConfig");
                return [];
            }

            const url = `${cluster.server}/apis/agones.dev/v1/namespaces/default/gameservers`;
            const opts: any = { method: "GET", headers: {} };

            // Apply Auth
            await kc.applyToFetchOptions(opts);

            // Bun/Node TLS handling
            if (cluster.skipTLSVerify || process.env.NODE_TLS_REJECT_UNAUTHORIZED == "0") {
                // @ts-ignore
                opts.tls = { rejectUnauthorized: false };
            }

            const res = await fetch(url, opts as any);
            if (!res.ok) {
                const txt = await res.text();
                console.error(`❌ Raw fetch failed ${res.status}: ${txt}`);
                return [];
            }

            const json = await res.json();
            // @ts-ignore
            const items = json.items || [];

            return items.map((gs: any) => ({
                name: gs.metadata.name,
                state: gs.status.state,
                address: gs.status.address,
                port: gs.status.ports?.[0]?.port
            }));

        } catch (e) {
            console.error("❌ Failed to list GameServers (raw):", e);
            return [];
        }
    },

    async orphanPod(podName: string) {
        console.log(`🏷️  Orphaning pod ${podName} from Deployment...`);
        try {
            const patch = [
                {
                    op: "replace",
                    path: "/metadata/labels/app",
                    value: "browser-node-taken"
                }
            ];
            // @ts-ignore
            await k8s.patchNamespacedPod({
                name: podName,
                namespace: "default",
                body: patch
            }, { headers: { "Content-Type": "application/json-patch+json" } } as any);
        } catch (e) {
            console.error("❌ Failed to patch pod labels:", e);
        }
    },

    async deletePod(podName: string) {
        console.log(`💀 Deleting pod: ${podName}`);
        try {
            // @ts-ignore
            await k8s.deleteNamespacedPod({
                name: podName,
                namespace: "default"
            });
        } catch (e) {
            console.error("❌ Error deleting pod:", e);
        }
    },

    async listBrowserPods() {
        try {
            // @ts-ignore
            const res = await k8s.listNamespacedPod({
                namespace: "default"
            });

            // Handle both { body: ... } (standard) and V1PodList (type-inferred) returns
            const allPods = (res as any).body?.items || (res as any).items || [];

            const browserPods = allPods.filter((p: any) => {
                const labels = p.metadata?.labels || {};
                return labels['app'] === 'browser-node' ||
                    labels['app'] === 'browser-node-taken' ||
                    labels['agones.dev/role'] === 'gameserver';
            });

            return browserPods.map((p: any) => ({
                name: p.metadata?.name,
                ip: p.status?.podIP,
                phase: p.status?.phase,
                deletionTimestamp: p.metadata?.deletionTimestamp,
                labels: p.metadata?.labels
            }));
        } catch (e) {
            console.error("❌ Failed to list pods:", e);
            return [];
        }
    },

    async getDeploymentReplicas(name: string): Promise<number> {
        try {
            // @ts-ignore
            const res = await k8sApps.readNamespacedDeployment({
                name,
                namespace: "default"
            });
            // Handle both { body: ... } and V1Deployment returns
            return (res as any).body?.spec?.replicas || (res as any).spec?.replicas || 0;
        } catch (e) {
            console.error(`❌ Failed to get deployment ${name}:`, e);
            return 0;
        }
    },

    async scaleDeployment(name: string, replicas: number) {
        console.log(`⚖️  Scaling deployment ${name} to ${replicas}...`);
        try {
            // @ts-ignore
            await k8sApps.patchNamespacedDeployment({
                name,
                namespace: "default",
                body: { spec: { replicas } }
            }, { headers: { "Content-Type": "application/merge-patch+json" } } as any);
        } catch (e) {
            console.error(`❌ Failed to scale deployment ${name}:`, e);
        }
    },

    async getGameServerPodIP(gameServerName: string): Promise<string | null> {
        try {
            const cluster = kc.getCurrentCluster();
            if (!cluster) return null;

            const url = `${cluster.server}/apis/agones.dev/v1/namespaces/default/gameservers/${gameServerName}`;
            const opts: any = { method: "GET", headers: {} };
            await kc.applyToFetchOptions(opts);
            if (cluster.skipTLSVerify || process.env.NODE_TLS_REJECT_UNAUTHORIZED == "0") {
                // @ts-ignore
                opts.tls = { rejectUnauthorized: false };
            }

            const res = await fetch(url, opts as any);
            if (!res.ok) return null;

            const json = await res.json() as any;

            // Agones allocates status.address (Node IP) usually, but we want the POD IP if possible.
            // However, Agones might NOT expose PodIP in the GameServer status directly nicely everywhere.
            // BUT, usually GameServer name == Pod name.
            // So we can try to fetch the POD with this name.

            // NOTE: Agones GameServers create a Pod with the same name.
            return await K8s.getPodIP(gameServerName);

        } catch (e) {
            console.error(`❌ Failed to get GameServer IP ${gameServerName}:`, e);
            return null;
        }
    },

    async getPodIP(podName: string): Promise<string | null> {
        try {
            // @ts-ignore
            const res = await k8s.readNamespacedPod({
                name: podName,
                namespace: "default"
            });
            // @ts-ignore
            return (res as any).body?.status?.podIP || (res as any).status?.podIP || null;
        } catch (e) {
            console.error(`❌ Failed to get Pod IP for ${podName}:`, e);
            return null;
        }
    }
}
