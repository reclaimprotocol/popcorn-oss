import postgres from 'postgres';
import type {
  AuthorizationCode,
  DeviceNonce,
  DeviceRecord,
  McpStore,
  OAuthClient,
  OperationRecord,
  PendingCommit,
  SessionRecord,
} from './store';

/**
 * Durable, transactional implementation of `McpStore`.
 *
 * `claimOperation` is a single `INSERT ... ON CONFLICT DO NOTHING`, so
 * concurrent replicas cannot both win the same operation claim. Usage credit
 * lives behind `BillingProvider`, not here.
 */
export class PostgresStore implements McpStore {
  constructor(private readonly sql: postgres.Sql) {}

  static fromUrl(url: string): PostgresStore {
    return new PostgresStore(postgres(url, { max: 10, onnotice: () => {} }));
  }

  async migrate(): Promise<void> {
    await this.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
        client_id TEXT PRIMARY KEY,
        client_name TEXT NOT NULL,
        redirect_uris JSONB NOT NULL,
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_auth_codes (
        code TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        scope TEXT NOT NULL,
        resource TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        consumed BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS mcp_operations (
        ref TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        outcome TEXT NOT NULL,
        result JSONB,
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_sessions (
        session_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        purpose TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT,
        ended_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS mcp_sessions_subject ON mcp_sessions (subject);
      -- Billing commits we owe the provider. Written before the commit is
      -- attempted, so a crash cannot lose the obligation to settle.
      CREATE TABLE IF NOT EXISTS mcp_pending_commits (
        reservation_id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        operation_ref TEXT NOT NULL,
        operation TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at BIGINT NOT NULL,
        next_attempt_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mcp_pending_commits_due ON mcp_pending_commits (next_attempt_at);
      CREATE TABLE IF NOT EXISTS mcp_device_nonces (
        value TEXT PRIMARY KEY,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        consumed BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS mcp_devices (
        subject TEXT PRIMARY KEY,
        thumbprint TEXT NOT NULL UNIQUE,
        created_at BIGINT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mcp_revocations (
        subject TEXT PRIMARY KEY,
        issued_before BIGINT NOT NULL
      );
    `);
  }

  /* ----------------------------------------------------- operations */

  async claimOperation(ref: string, subject: string) {
    const now = Date.now();
    const inserted = await this.sql<any[]>`
      INSERT INTO mcp_operations (ref, subject, outcome, result, created_at)
      VALUES (${ref}, ${subject}, 'pending', NULL, ${now})
      ON CONFLICT (ref) DO NOTHING
      RETURNING ref
    `;
    if (inserted.length > 0) return { claimed: true, existing: null };
    return { claimed: false, existing: await this.getOperation(ref) };
  }

  async settleOperation(ref: string, outcome: 'succeeded' | 'failed', result: unknown) {
    await this.sql`
      UPDATE mcp_operations SET outcome = ${outcome}, result = ${this.sql.json(result as any)} WHERE ref = ${ref}
    `;
  }

  async releaseOperation(ref: string) {
    await this.sql`DELETE FROM mcp_operations WHERE ref = ${ref}`;
  }

  async getOperation(ref: string): Promise<OperationRecord | null> {
    const [row] = await this.sql<any[]>`SELECT * FROM mcp_operations WHERE ref = ${ref}`;
    if (!row) return null;
    return { ref: row.ref, subject: row.subject, outcome: row.outcome, result: row.result, createdAt: Number(row.created_at) };
  }

  /* --------------------------------------------------------- oauth */

  async putClient(client: OAuthClient) {
    await this.sql`
      INSERT INTO mcp_oauth_clients (client_id, client_name, redirect_uris, created_at)
      VALUES (${client.clientId}, ${client.clientName}, ${this.sql.json(client.redirectUris)}, ${client.createdAt})
      ON CONFLICT (client_id) DO NOTHING
    `;
  }

  async getClient(clientId: string) {
    const [row] = await this.sql<any[]>`SELECT * FROM mcp_oauth_clients WHERE client_id = ${clientId}`;
    if (!row) return null;
    return { clientId: row.client_id, clientName: row.client_name, redirectUris: row.redirect_uris, createdAt: Number(row.created_at) };
  }

  async putCode(code: AuthorizationCode) {
    await this.sql`
      INSERT INTO mcp_auth_codes (code, client_id, subject, redirect_uri, code_challenge, scope, resource, expires_at, consumed)
      VALUES (${code.code}, ${code.clientId}, ${code.subject}, ${code.redirectUri}, ${code.codeChallenge},
              ${code.scope}, ${code.resource}, ${code.expiresAt}, FALSE)
    `;
  }

  /** Single-use: the UPDATE only matches an unconsumed row. */
  async consumeCode(code: string) {
    const [row] = await this.sql<any[]>`
      UPDATE mcp_auth_codes SET consumed = TRUE WHERE code = ${code} AND consumed = FALSE RETURNING *
    `;
    if (!row) return null;
    return {
      code: row.code,
      clientId: row.client_id,
      subject: row.subject,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      codeChallengeMethod: 'S256' as const,
      scope: row.scope,
      resource: row.resource,
      expiresAt: Number(row.expires_at),
      consumed: true,
    };
  }

  async revokeSubjectBefore(subject: string, issuedBefore: number) {
    await this.sql`
      INSERT INTO mcp_revocations (subject, issued_before) VALUES (${subject}, ${issuedBefore})
      ON CONFLICT (subject) DO UPDATE SET issued_before = GREATEST(mcp_revocations.issued_before, EXCLUDED.issued_before)
    `;
  }

  async revokedAt(subject: string) {
    const [row] = await this.sql<any[]>`SELECT issued_before FROM mcp_revocations WHERE subject = ${subject}`;
    return row ? Number(row.issued_before) : 0;
  }

  /* ------------------------------------------------ pending commits */

  async putPendingCommit(pending: PendingCommit) {
    await this.sql`
      INSERT INTO mcp_pending_commits (reservation_id, subject, operation_ref, operation, attempts, last_error, created_at, next_attempt_at)
      VALUES (${pending.reservationId}, ${pending.subject}, ${pending.operationRef}, ${pending.operation}, ${pending.attempts}, ${pending.lastError}, ${pending.createdAt}, ${pending.nextAttemptAt})
      ON CONFLICT (reservation_id) DO NOTHING
    `;
  }

  async deletePendingCommit(reservationId: string) {
    await this.sql`DELETE FROM mcp_pending_commits WHERE reservation_id = ${reservationId}`;
  }

  async recordCommitAttempt(reservationId: string, error: string, nextAttemptAt: number) {
    await this.sql`
      UPDATE mcp_pending_commits
      SET attempts = attempts + 1, last_error = ${error}, next_attempt_at = ${nextAttemptAt}
      WHERE reservation_id = ${reservationId}
    `;
  }

  async dueCommits(now: number, limit: number) {
    const rows = await this.sql<any[]>`
      SELECT * FROM mcp_pending_commits
      WHERE next_attempt_at <= ${now}
      ORDER BY next_attempt_at ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      reservationId: row.reservation_id,
      subject: row.subject,
      operationRef: row.operation_ref,
      operation: row.operation,
      attempts: Number(row.attempts),
      lastError: row.last_error,
      createdAt: Number(row.created_at),
      nextAttemptAt: Number(row.next_attempt_at),
    }));
  }

  /* ------------------------------------------------------- sessions */

  async putSession(session: SessionRecord) {
    await this.sql`
      INSERT INTO mcp_sessions (session_id, subject, purpose, created_at, expires_at, ended_at)
      VALUES (${session.sessionId}, ${session.subject}, ${session.purpose}, ${session.createdAt},
              ${session.expiresAt}, ${session.endedAt})
      ON CONFLICT (session_id) DO NOTHING
    `;
  }

  async getSession(sessionId: string) {
    const [row] = await this.sql<any[]>`SELECT * FROM mcp_sessions WHERE session_id = ${sessionId}`;
    return row ? this.toSession(row) : null;
  }

  async updateSession(sessionId: string, patch: Partial<SessionRecord>) {
    if (patch.expiresAt !== undefined) {
      await this.sql`UPDATE mcp_sessions SET expires_at = ${patch.expiresAt} WHERE session_id = ${sessionId}`;
    }
    if (patch.endedAt !== undefined) {
      await this.sql`UPDATE mcp_sessions SET ended_at = ${patch.endedAt} WHERE session_id = ${sessionId}`;
    }
  }

  async listSessions(subject: string, limit: number) {
    const rows = await this.sql<any[]>`
      SELECT * FROM mcp_sessions WHERE subject = ${subject} ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map((row) => this.toSession(row));
  }

  private toSession(row: any): SessionRecord {
    return {
      sessionId: row.session_id,
      subject: row.subject,
      purpose: row.purpose,
      createdAt: Number(row.created_at),
      expiresAt: row.expires_at === null ? null : Number(row.expires_at),
      endedAt: row.ended_at === null ? null : Number(row.ended_at),
    };
  }

  /* --------------------------------------------------------- device */

  async putNonce(nonce: DeviceNonce) {
    await this.sql`
      INSERT INTO mcp_device_nonces (value, created_at, expires_at, consumed)
      VALUES (${nonce.value}, ${nonce.createdAt}, ${nonce.expiresAt}, FALSE)
      ON CONFLICT (value) DO NOTHING
    `;
  }

  /** Single-use in one statement: only an unconsumed row is returned. */
  async consumeNonce(value: string) {
    const [row] = await this.sql<any[]>`
      UPDATE mcp_device_nonces SET consumed = TRUE WHERE value = ${value} AND consumed = FALSE RETURNING *
    `;
    if (!row) return null;
    return {
      value: row.value,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      consumed: false,
    };
  }

  async putDevice(device: DeviceRecord) {
    await this.sql`
      INSERT INTO mcp_devices (subject, thumbprint, created_at)
      VALUES (${device.subject}, ${device.thumbprint}, ${device.createdAt})
      ON CONFLICT (subject) DO NOTHING
    `;
  }

  async getDevice(subject: string): Promise<DeviceRecord | null> {
    const [row] = await this.sql<any[]>`SELECT * FROM mcp_devices WHERE subject = ${subject}`;
    return row ? { subject: row.subject, thumbprint: row.thumbprint, createdAt: Number(row.created_at) } : null;
  }
}
