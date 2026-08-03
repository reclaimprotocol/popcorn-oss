export interface SessionEvent {
  sessionId: string;
  clientId: string;
  clusterName: string;
  eventType: 'created' | 'deleted';
  timestamp: Date;
  durationSeconds?: number;
  metadata?: any;
}

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface Client {
  id: string;
  name: string;
  createdAt: Date;
  active: boolean;
  allowedClusters: string[] | null;
}
