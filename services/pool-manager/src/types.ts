export interface Pod {
    name: string;
    namespace?: string;
    url: string;
    ip?: string;
    clientId?: string;
    createdAt?: number;
}

export interface Session {
    id: string;
    podName: string;
    podUrl: string;
    podIp: string;
    createdAt: number;
}

export interface AllocationResponse {
    gameServerName: string;
    address: string;
    nodeName: string;
    ports: {
        name: string;
        port: number;
        protocol?: string;
    }[];
}

export interface GameServerStatus {
    name: string;
    status: string;
}

export interface SessionResponse {
    success: boolean;
    sessionId: string;
    url: string;
    cdpUrl: string;
    apiUrl: string;
    browserPodId?: string;
}
