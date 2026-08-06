import { KubeConfig } from '@kubernetes/client-node';
import { Pod } from '../types';
import { RuntimeConfig } from '../config';
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

export function buildMetadataAnnotationsPatch(annotations: Record<string, string>) {
    return {
        metadata: {
            annotations,
        },
    };
}

export const K8s = {
    async listBrowserPods(namespace: string = RuntimeConfig.gameServerNamespace) {
        try {
            const res = await k8sJson(`/api/v1/namespaces/${namespace}/pods`, {
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

    async getGameServerPodIP(gameServerName: string, namespace: string = RuntimeConfig.gameServerNamespace): Promise<string | null> {
        try {
            const res = await k8sJson(`/apis/agones.dev/v1/namespaces/${namespace}/gameservers/${gameServerName}`, {
                method: "GET",
            });
            if (!res.ok) return null;

            await res.json() as any;

            // Agones allocates status.address (Node IP) usually, but we want the POD IP if possible.
            // However, Agones might NOT expose PodIP in the GameServer status directly nicely everywhere.
            // BUT, usually GameServer name == Pod name.
            // So we can try to fetch the POD with this name.

            // NOTE: Agones GameServers create a Pod with the same name.
            return await K8s.getPodIP(gameServerName, namespace);

        } catch (e) {
            console.error(`❌ Failed to get GameServer IP ${gameServerName}:`, e);
            return null;
        }
    },

    async getPodIP(podName: string, namespace: string = RuntimeConfig.gameServerNamespace): Promise<string | null> {
        try {
            const res = await k8sJson(`/api/v1/namespaces/${namespace}/pods/${podName}`, {
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

    async getPodMetadata(podName: string, namespace: string = RuntimeConfig.gameServerNamespace): Promise<{ uid: string | null, namespace: string }> {
        try {
            return await retry(async () => {
                const res = await k8sJson(`/api/v1/namespaces/${namespace}/pods/${podName}`, {
                    method: "GET",
                });
                if (!res.ok) {
                    throw new Error(`Read pod failed ${res.status}: ${await res.text()}`);
                }
                const json = await res.json() as any;
                return {
                    uid: json.metadata?.uid || null,
                    namespace: json.metadata?.namespace || namespace,
                };
            }, {
                attempts: 5,
                delayMs: 500,
            });
        } catch (e) {
            console.error(`❌ Failed to get Pod metadata for ${podName}:`, e);
        }
        return { uid: null, namespace };
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
    },

    async patchPod(namespace: string, name: string, patch: any): Promise<void> {
        try {
            const res = await k8sJson(`/api/v1/namespaces/${namespace}/pods/${name}`, {
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
            console.error(`❌ Failed to patch Pod ${name}:`, e);
            throw e;
        }
    }
}
