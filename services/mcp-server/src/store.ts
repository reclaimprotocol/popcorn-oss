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
  expiresAt: number;
  consumed: boolean;
};

export type TopUp = {
  id: string;
  subject: string;
  amountUsdCents: number;
  status: 'pending' | 'credited' | 'cancelled';
  checkoutUrl: string;
  providerRef: string;
  createdAt: number;
};

export type LedgerEntry = {
  id: string;
  subject: string;
  deltaUsdCents: number;
  reason: string;
  ref: string;
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

export type OtpChallenge = {
  id: string;
  email: string;
  codeHash: string;
  attempts: number;
  verified: boolean;
  createdAt: number;
  expiresAt: number;
};

export interface McpStore {
  putOtp(challenge: OtpChallenge): Promise<void>;
  getOtp(id: string): Promise<OtpChallenge | null>;
  updateOtp(id: string, patch: Partial<OtpChallenge>): Promise<void>;
  countRecentOtps(email: string, since: number): Promise<number>;

  putSession(session: SessionRecord): Promise<void>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  updateSession(sessionId: string, patch: Partial<SessionRecord>): Promise<void>;
  listSessions(subject: string, limit: number): Promise<SessionRecord[]>;

  putClient(client: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | null>;

  putCode(code: AuthorizationCode): Promise<void>;
  consumeCode(code: string): Promise<AuthorizationCode | null>;

  putTopUp(topUp: TopUp): Promise<void>;
  getTopUp(id: string): Promise<TopUp | null>;
  getTopUpByProviderRef(ref: string): Promise<TopUp | null>;
  updateTopUpStatus(id: string, status: TopUp['status']): Promise<void>;

  appendLedger(entry: LedgerEntry): Promise<void>;
  hasLedgerRef(ref: string): Promise<boolean>;
  balanceUsdCents(subject: string): Promise<number>;
  listLedger(subject: string, limit: number): Promise<LedgerEntry[]>;
}

export class InMemoryStore implements McpStore {
  private clients = new Map<string, OAuthClient>();
  private codes = new Map<string, AuthorizationCode>();
  private topUps = new Map<string, TopUp>();
  private ledger: LedgerEntry[] = [];
  private sessions = new Map<string, SessionRecord>();
  private otps = new Map<string, OtpChallenge>();

  async putOtp(challenge: OtpChallenge) {
    this.otps.set(challenge.id, challenge);
  }

  async getOtp(id: string) {
    return this.otps.get(id) ?? null;
  }

  async updateOtp(id: string, patch: Partial<OtpChallenge>) {
    const found = this.otps.get(id);
    if (found) this.otps.set(id, { ...found, ...patch });
  }

  async countRecentOtps(email: string, since: number) {
    return [...this.otps.values()].filter((otp) => otp.email === email && otp.createdAt >= since).length;
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

  async putTopUp(topUp: TopUp) {
    this.topUps.set(topUp.id, topUp);
  }

  async getTopUp(id: string) {
    return this.topUps.get(id) ?? null;
  }

  async getTopUpByProviderRef(ref: string) {
    for (const topUp of this.topUps.values()) {
      if (topUp.providerRef === ref) return topUp;
    }
    return null;
  }

  async updateTopUpStatus(id: string, status: TopUp['status']) {
    const found = this.topUps.get(id);
    if (found) this.topUps.set(id, { ...found, status });
  }

  async appendLedger(entry: LedgerEntry) {
    this.ledger.push(entry);
  }

  async hasLedgerRef(ref: string) {
    return this.ledger.some((entry) => entry.ref === ref);
  }

  async balanceUsdCents(subject: string) {
    return this.ledger
      .filter((entry) => entry.subject === subject)
      .reduce((total, entry) => total + entry.deltaUsdCents, 0);
  }

  async listLedger(subject: string, limit: number) {
    return this.ledger
      .filter((entry) => entry.subject === subject)
      .slice(-limit)
      .reverse();
  }
}
