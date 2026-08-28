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

export type TopUp = {
  id: string;
  subject: string;
  amountUsdCents: number;
  status: 'pending' | 'credited' | 'cancelled';
  checkoutUrl: string;
  providerRef: string | null;
  createdAt: number;
};

export type OperationRecord = {
  ref: string;
  subject: string;
  outcome: 'pending' | 'succeeded' | 'failed';
  result: unknown;
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
  /** Salted hash of the address. The plaintext email is never persisted. */
  emailHash: string;
  subject: string;
  codeHash: string;
  attempts: number;
  verified: boolean;
  createdAt: number;
  expiresAt: number;
};

export interface McpStore {
  /**
   * Atomically apply a ledger entry.
   *
   * Contract for durable implementations: this MUST be a single transaction
   * that (a) no-ops if `entry.ref` already exists, and (b) for a negative
   * delta, rejects when the subject's balance would go below zero — e.g.
   *   INSERT ... SELECT ... WHERE (SELECT COALESCE(SUM(delta),0) FROM ledger
   *   WHERE subject = $1) + $delta >= 0 ON CONFLICT (ref) DO NOTHING
   * A read-then-write sequence is not acceptable for a payment path.
   */
  applyLedgerEntry(entry: LedgerEntry): Promise<{ applied: boolean; duplicate: boolean; balanceUsdCents: number }>;

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
  /** Attach Checkout details WITHOUT touching `status`. */
  attachCheckout(id: string, checkoutUrl: string, providerRef: string): Promise<void>;

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

  async countRecentOtps(emailHash: string, since: number) {
    return [...this.otps.values()].filter((otp) => otp.emailHash === emailHash && otp.createdAt >= since).length;
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

  async attachCheckout(id: string, checkoutUrl: string, providerRef: string) {
    const found = this.topUps.get(id);
    if (found) this.topUps.set(id, { ...found, checkoutUrl, providerRef });
  }

  async updateTopUpStatus(id: string, status: TopUp['status']) {
    const found = this.topUps.get(id);
    if (found) this.topUps.set(id, { ...found, status });
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

  /**
   * Single-threaded and therefore atomic in this process. A multi-replica
   * deployment must supply a store whose implementation is transactional.
   */
  async applyLedgerEntry(entry: LedgerEntry) {
    // Deliberately synchronous between the check and the write: no `await`
    // may separate them, or two in-flight debits can both pass the check.
    const balanceOf = (subject: string) =>
      this.ledger.filter((existing) => existing.subject === subject).reduce((total, e) => total + e.deltaUsdCents, 0);
    if (this.ledger.some((existing) => existing.ref === entry.ref)) {
      return { applied: false, duplicate: true, balanceUsdCents: balanceOf(entry.subject) };
    }
    const balance = balanceOf(entry.subject);
    if (balance + entry.deltaUsdCents < 0) {
      return { applied: false, duplicate: false, balanceUsdCents: balance };
    }
    this.ledger.push(entry);
    return { applied: true, duplicate: false, balanceUsdCents: balance + entry.deltaUsdCents };
  }

  async revokeSubjectBefore(subject: string, issuedBefore: number) {
    this.revocations.set(subject, issuedBefore);
  }

  async revokedAt(subject: string) {
    return this.revocations.get(subject) ?? 0;
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
