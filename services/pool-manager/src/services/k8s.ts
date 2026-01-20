import { KubeConfig, CoreV1Api, AppsV1Api } from '@kubernetes/client-node';
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

export const K8s = {
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

            // Log simple count for visibility
            console.log(`🔍 K8s: Found ${allPods.length} total pods.`);

            const browserPods = allPods.filter((p: any) => {
                const app = p.metadata?.labels?.app;
                return app === 'browser-node' || app === 'browser-node-taken';
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
    }
}
