interface AllocatedPort {
    name: string;
    port: number;
}

/** Select the VNC endpoint even when Agones returns another port first. */
export function browserRoutePort(ports: AllocatedPort[] | undefined): number {
    return ports?.find((port) => port.name === "novnc")?.port
        ?? 6080;
}
