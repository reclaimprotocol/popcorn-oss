import { readFileSync } from "node:fs";
import { KubeConfig } from "@kubernetes/client-node";

function getClusterConfig(kc: KubeConfig) {
    const cluster = kc.getCurrentCluster();
    if (!cluster) {
        throw new Error("No K8s cluster config");
    }

    return cluster;
}

function getClusterCa(kc: KubeConfig): string | undefined {
    const cluster = getClusterConfig(kc);

    if (cluster.caData) {
        return Buffer.from(cluster.caData, "base64").toString("utf8");
    }

    if (cluster.caFile) {
        return readFileSync(cluster.caFile, "utf8");
    }

    return undefined;
}

export async function buildK8sFetchRequest(kc: KubeConfig, opts: RequestInit = {}) {
    const cluster = getClusterConfig(kc);
    const requestOpts: any = {
        ...opts,
        headers: {
            ...(opts.headers || {}),
        },
    };

    const requestInit = await kc.applyToFetchOptions(requestOpts as any);
    const ca = getClusterCa(kc);

    const finalInit: any = {
        ...opts,
        ...requestInit,
        headers: requestInit.headers ?? requestOpts.headers,
    };

    if (cluster.skipTLSVerify || ca) {
        finalInit.tls = {
            ...(opts as any).tls,
            ...(cluster.skipTLSVerify ? { rejectUnauthorized: false } : {}),
            ...(ca ? { ca } : {}),
        };
    }

    return finalInit;
}

export function getK8sClusterServer(kc: KubeConfig) {
    return getClusterConfig(kc).server;
}
