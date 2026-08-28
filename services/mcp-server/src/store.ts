/**
 * Persistence boundary for the MCP adapter.
 *
 * The default implementation is in-memory so the service runs standalone in
 * Kind and in tests. Operators running multiple replicas should supply a
 * durable implementation (Postgres/Redis) with the same interface.
 */

export type OAuthClient = {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
};

export type AuthorizationCode = {
  code: string;
  clientId: string;
  subject: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string;
  /** The RFC 8707 resource this code — and the resulting token — is bound to. */
  resource: string;
  expiresAt: number;
  consumed: boolean;
};

export type OperationRecord = {
  ref: string;
  subject: string;
  outcome: 'pending' | 'succeeded' | 'failed';
  result: unknown;
  createdAt: number;
};

export type SessionRecord = {
  sessionId: string;
  subject: string;
  purpose: string;
  createdAt: number;
  expiresAt: number | null;
  endedAt: number | null;
};

export type DeviceNonce = {
  value: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
};

export type DeviceRecord = {
  subject: string;
  thumbprint: string;
  createdAt: number;
};

export interface McpStore {

  /**
   * Operation-level idempotency. `claimOperation` MUST be a single atomic
   * insert-if-absent (`INSERT ... ON CONFLICT (ref) DO NOTHING RETURNING`):
   * exactly one caller wins the claim and performs the effect; every other
   * caller gets the existing record and replays or waits for its outcome.
   */
  claimOperation(ref: string, subject: string): Promise<{ claimed: boolean; existing: OperationRecord | null }>;
  settleOperation(ref: string, outcome: 'succeeded' | 'failed', result: unknown): Promise<void>;
  releaseOperation(ref: string): Promise<void>;
  getOperation(ref: string): Promise<OperationRecord | null>;

  revokeSubjectBefore(subject: string, issuedBefore: number): Promise<void>;
  revokedAt(subject: string): Promise<number>;

  putNonce(nonce: DeviceNonce): Promise<void>;
  /** Single-use: returns the nonce only on the first call. */
  consumeNonce(value: string): Promise<DeviceNonce | null>;
  putDevice(device: DeviceRecord): Promise<void>;
  getDevice(subject: string): Promise<DeviceRecord | null>;

  putSession(session: SessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  updateSession(sessionId: string, patch: Partial<SessionRecord>): Promise<void>;
  listSessions(subject: string, limit: number): Promise<SessionRecord[]>;

  putClient(client: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | null>;

  putCode(code: AuthorizationCode): Promise<void>;
  consumeCode(code: string): Promise<AuthorizationCode | null>;

}

export class InMemoryStore implements McpStore {
  private clients = new Map<string, OAuthClient>();
  private codes = new Map<string, AuthorizationCode>();
  private sessions = new Map<string, SessionRecord>();
  private nonces = new Map<string, DeviceNonce>();
  private devices = new Map<string, DeviceRecord>();

  async putNonce(nonce: DeviceNonce) {
    this.nonces.set(nonce.value, nonce);
  }

  async consumeNonce(value: string) {
    const found = this.nonces.get(value);
    if (!found || found.consumed) return null;
    this.nonces.set(value, { ...found, consumed: true });
    return found;
  }

  async putDevice(device: DeviceRecord) {
    if (!this.devices.has(device.subject)) this.devices.set(device.subject, device);
  }

  async getDevice(subject: string) {
    return this.devices.get(subject) ?? null;
  }

  async putSession(session: SessionRecord) {
    this.sessions.set(session.sessionId, session);
  }

  async getSession(sessionId: string) {
    return this.sessions.get(sessionId) ?? null;
  }

  async updateSession(sessionId: string, patch: Partial<SessionRecord>) {
    const found = this.sessions.get(sessionId);
    if (found) this.sessions.set(sessionId, { ...found, ...patch });
  }

  async listSessions(subject: string, limit: number) {
    return [...this.sessions.values()]
      .filter((session) => session.subject === subject)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async putClient(client: OAuthClient) {
    this.clients.set(client.clientId, client);
  }

  async getClient(clientId: string) {
    return this.clients.get(clientId) ?? null;
  }

  async putCode(code: AuthorizationCode) {
    this.codes.set(code.code, code);
  }

  async consumeCode(code: string) {
    const found = this.codes.get(code);
    if (!found || found.consumed) return null;
    found.consumed = true;
    this.codes.set(code, found);
    return found;
  }

  private revocations = new Map<string, number>();
  private operations = new Map<string, OperationRecord>();

  /** Synchronous check-and-set: no `await` may split the claim. */
  async claimOperation(ref: string, subject: string) {
    const existing = this.operations.get(ref);
    if (existing) return { claimed: false, existing };
    this.operations.set(ref, { ref, subject, outcome: 'pending', result: null, createdAt: Date.now() });
    return { claimed: true, existing: null };
  }

  async settleOperation(ref: string, outcome: 'succeeded' | 'failed', result: unknown) {
    const existing = this.operations.get(ref);
    if (existing) this.operations.set(ref, { ...existing, outcome, result });
  }

  async releaseOperation(ref: string) {
    this.operations.delete(ref);
  }

  async getOperation(ref: string) {
    return this.operations.get(ref) ?? null;
  }

  async revokeSubjectBefore(subject: string, issuedBefore: number) {
    this.revocations.set(subject, issuedBefore);
  }

  async revokedAt(subject: string) {
    return this.revocations.get(subject) ?? 0;
  }

}
