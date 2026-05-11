import { KubeConfig } from '@kubernetes/client-node';
import { Pod } from '../types';
import { buildK8sFetchRequest, getK8sClusterServer } from './k8s-fetch';
import { retry } from './retry';

const kc = new KubeConfig();
try {
    kc.loadFromDefault();
} catch (e) {
    console.warn("⚠️ Failed to load KubeConfig (running outside cluster without config?)");
}

async function buildFetchOptions(opts: any = {}) {
    return buildK8sFetchRequest(kc, opts);
}

async function k8sJson(path: string, opts: any = {}) {
    const requestOpts = await buildFetchOptions(opts);
    const res = await fetch(`${getK8sClusterServer(kc)}${path}`, requestOpts as any);
    return res;
}

export const K8s = {
    // ... existing methods ...
    async listGameServers() {
        try {
            const res = await k8sJson(`/apis/agones.dev/v1/namespaces/default/gameservers`, { method: "GET" });
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
                    value: "browser-runtime-taken"
                }
            ];
            const res = await k8sJson(`/api/v1/namespaces/default/pods/${podName}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json-patch+json" },
                body: JSON.stringify(patch),
            });
            if (!res.ok) {
                throw new Error(`Patch failed ${res.status}: ${await res.text()}`);
            }
        } catch (e) {
            console.error("❌ Failed to patch pod labels:", e);
        }
    },

    async deletePod(podName: string) {
        console.log(`💀 Deleting pod: ${podName}`);
        try {
            const res = await k8sJson(`/api/v1/namespaces/default/pods/${podName}`, {
                method: "DELETE",
            });
            if (!res.ok && res.status !== 404) {
                throw new Error(`Delete failed ${res.status}: ${await res.text()}`);
            }
        } catch (e) {
            console.error("❌ Error deleting pod:", e);
        }
    },

    async listBrowserPods() {
        try {
            const res = await k8sJson(`/api/v1/namespaces/default/pods`, {
                method: "GET",
            });
            if (!res.ok) {
                throw new Error(`List pods failed ${res.status}: ${await res.text()}`);
            }
            const json = await res.json() as any;
            const allPods = json.items || [];

            const browserPods = allPods.filter((p: any) => {
                const labels = p.metadata?.labels || {};
                return labels['app'] === 'browser-runtime' ||
                    labels['app'] === 'browser-runtime-taken' ||
                    labels['app'] === 'browser-node' ||
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
            const res = await k8sJson(`/apis/apps/v1/namespaces/default/deployments/${name}`, {
                method: "GET",
            });
            if (!res.ok) {
                throw new Error(`Get deployment failed ${res.status}: ${await res.text()}`);
            }
            const json = await res.json() as any;
            return json.spec?.replicas || 0;
        } catch (e) {
            console.error(`❌ Failed to get deployment ${name}:`, e);
            return 0;
        }
    },

    async scaleDeployment(name: string, replicas: number) {
        console.log(`⚖️  Scaling deployment ${name} to ${replicas}...`);
        try {
            const res = await k8sJson(`/apis/apps/v1/namespaces/default/deployments/${name}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/merge-patch+json" },
                body: JSON.stringify({ spec: { replicas } }),
            });
            if (!res.ok) {
                throw new Error(`Scale failed ${res.status}: ${await res.text()}`);
            }
        } catch (e) {
            console.error(`❌ Failed to scale deployment ${name}:`, e);
        }
    },

    async getGameServerPodIP(gameServerName: string): Promise<string | null> {
        try {
            const res = await k8sJson(`/apis/agones.dev/v1/namespaces/default/gameservers/${gameServerName}`, {
                method: "GET",
            });
            if (!res.ok) return null;

            await res.json() as any;

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
            const res = await k8sJson(`/api/v1/namespaces/default/pods/${podName}`, {
                method: "GET",
            });
            if (!res.ok) {
                throw new Error(`Read pod failed ${res.status}: ${await res.text()}`);
            }
            const json = await res.json() as any;
            return json.status?.podIP || null;
        } catch (e) {
            console.error(`❌ Failed to get Pod IP for ${podName}:`, e);
            return null;
        }
    },

    async getPodMetadata(podName: string): Promise<{ uid: string | null, namespace: string }> {
        try {
            return await retry(async () => {
                const res = await k8sJson(`/api/v1/namespaces/default/pods/${podName}`, {
                    method: "GET",
                });
                if (!res.ok) {
                    throw new Error(`Read pod failed ${res.status}: ${await res.text()}`);
                }
                const json = await res.json() as any;
                return {
                    uid: json.metadata?.uid || null,
                    namespace: json.metadata?.namespace || "default",
                };
            }, {
                attempts: 5,
                delayMs: 500,
            });
        } catch (e) {
            console.error(`❌ Failed to get Pod metadata for ${podName}:`, e);
        }
        return { uid: null, namespace: "default" };
    },

    async patchGameServer(namespace: string, name: string, patch: any): Promise<void> {
        try {
            const res = await k8sJson(`/apis/agones.dev/v1/namespaces/${namespace}/gameservers/${name}`, {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/merge-patch+json"
                },
                body: JSON.stringify(patch)
            });
            if (!res.ok) {
                const txt = await res.text();
                throw new Error(`Patch failed ${res.status}: ${txt}`);
            }
        } catch (e) {
            console.error(`❌ Failed to patch GameServer ${name}:`, e);
            throw e;
        }
    }
}
