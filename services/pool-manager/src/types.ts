export interface Pod {
    name: string;
    url: string;
    ip?: string;
}

export interface Session {
    id: string;
    podName: string;
    podUrl: string;
    podIp: string;
    createdAt: number;
}

export interface RegisterRequest {
    name: string;
    url: string;
}

export interface TurnServerConfig {
    urls: string[];
    username: string;
    credential: string;
}

export interface RegisterResponse {
    sessionId?: string; // If we were to pre-assign, but mostly we just want them registered
    iceServers: TurnServerConfig[];
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
