const NAMESPACE_ENV_KEYS = ["GAME_SERVER_NAMESPACE", "POD_NAMESPACE", "K8S_NAMESPACE", "NAMESPACE"];
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

function readOptionalEnv(name: string): string | undefined {
    const value = process.env[name]?.trim();
    return value || undefined;
}

function validateNamespace(namespace: string, source: string): string {
    if (namespace.length > 63 || !DNS_LABEL.test(namespace)) {
        throw new Error(`Invalid Kubernetes namespace from ${source}: ${namespace}`);
    }
    return namespace;
}

function readNamespace(): string {
    for (const key of NAMESPACE_ENV_KEYS) {
        const value = readOptionalEnv(key);
        if (value) {
            return validateNamespace(value, key);
        }
    }
    return "default";
}

export const RuntimeConfig = {
    gameServerNamespace: readNamespace(),
    gameServerFleet: readOptionalEnv("GAME_SERVER_FLEET") || "browser-fleet",
};

export function namespacedServiceUrl(serviceName: string, port: number, namespace = RuntimeConfig.gameServerNamespace): string {
    return `http://${serviceName}.${namespace}.svc:${port}`;
}
