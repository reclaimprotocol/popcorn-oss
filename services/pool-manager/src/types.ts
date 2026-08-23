import type { SessionAccessPolicy } from "./session-access";

export interface Pod {
    name: string;
    namespace?: string;
    url: string;
    ip?: string;
    podUid?: string;
    boundAt?: string;
    clientId?: string;
    clientName?: string;
    createdAt?: number;
    expiresAt?: string;
    tokenExpiresAt?: string;
    accessExpiresAt?: string;
    accessPolicy?: SessionAccessPolicy;
    liveViewE2e?: {
        version: 1;
        clientPublicKey?: string;
        bindingSecretHash?: string;
        podPublicKey: string;
        podUid: string;
    };
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
