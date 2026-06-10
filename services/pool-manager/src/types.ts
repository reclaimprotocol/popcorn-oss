export interface Pod {
    name: string;
    namespace?: string;
    url: string;
    ip?: string;
    podUid?: string;
    boundAt?: string;
    clientId?: string;
    createdAt?: number;
    expiresAt?: string;
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
