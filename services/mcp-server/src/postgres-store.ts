import postgres from 'postgres';
import type {
  AuthorizationCode,
  DeviceNonce,
  DeviceRecord,
  LedgerEntry,
  McpStore,
  OAuthClient,
  OperationRecord,
  SessionRecord,
  TopUp,
} from './store';

/**
 * Durable, transactional implementation of `McpStore`.
 *
 * Every money-moving or claim operation is a single statement whose condition
 * is evaluated by Postgres, so concurrent replicas cannot interleave a check
 * with its write:
 *   - `applyLedgerEntry`: insert-if-ref-absent AND balance-stays-non-negative
 *   - `claimOperation`:   INSERT ... ON CONFLICT DO NOTHING
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
      CREATE TABLE IF NOT EXISTS mcp_top_ups (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        amount_usd_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        checkout_url TEXT NOT NULL DEFAULT '',
        provider_ref TEXT,
        created_at BIGINT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS mcp_top_ups_provider_ref ON mcp_top_ups (provider_ref) WHERE provider_ref IS NOT NULL;
      CREATE TABLE IF NOT EXISTS mcp_ledger (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        delta_usd_cents INTEGER NOT NULL,
        reason TEXT NOT NULL,
        ref TEXT NOT NULL UNIQUE,
        created_at BIGINT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mcp_ledger_subject ON mcp_ledger (subject);
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

  /* ---------------------------------------------------------- money */

  async applyLedgerEntry(entry: LedgerEntry) {
    const [row] = await this.sql<{ balance: string | null }[]>`
      WITH attempted AS (
        INSERT INTO mcp_ledger (id, subject, delta_usd_cents, reason, ref, created_at)
        SELECT ${entry.id}, ${entry.subject}, ${entry.deltaUsdCents}, ${entry.reason}, ${entry.ref}, ${entry.createdAt}
        WHERE (
          SELECT COALESCE(SUM(delta_usd_cents), 0) FROM mcp_ledger WHERE subject = ${entry.subject}
        ) + ${entry.deltaUsdCents} >= 0
        ON CONFLICT (ref) DO NOTHING
        RETURNING 1
      )
      SELECT
        (SELECT COUNT(*) FROM attempted) AS inserted,
        (SELECT COALESCE(SUM(delta_usd_cents), 0) FROM mcp_ledger WHERE subject = ${entry.subject}) AS balance
    ` as any;
    const inserted = Number((row as any).inserted) > 0;
    const balance = Number(row.balance ?? 0);
    if (inserted) return { applied: true, duplicate: false, balanceUsdCents: balance };
    const duplicate = await this.hasLedgerRef(entry.ref);
    return { applied: false, duplicate, balanceUsdCents: balance };
  }

  async appendLedger(entry: LedgerEntry) {
    await this.applyLedgerEntry(entry);
  }

  async hasLedgerRef(ref: string) {
    const rows = await this.sql`SELECT 1 FROM mcp_ledger WHERE ref = ${ref} LIMIT 1`;
    return rows.length > 0;
  }

  async balanceUsdCents(subject: string) {
    const [row] = await this.sql<{ balance: string }[]>`
      SELECT COALESCE(SUM(delta_usd_cents), 0) AS balance FROM mcp_ledger WHERE subject = ${subject}
    `;
    return Number(row?.balance ?? 0);
  }

  async listLedger(subject: string, limit: number) {
    const rows = await this.sql<any[]>`
      SELECT * FROM mcp_ledger WHERE subject = ${subject} ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      deltaUsdCents: row.delta_usd_cents,
      reason: row.reason,
      ref: row.ref,
      createdAt: Number(row.created_at),
    }));
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

  /* -------------------------------------------------------- top-ups */

  async putTopUp(topUp: TopUp) {
    await this.sql`
      INSERT INTO mcp_top_ups (id, subject, amount_usd_cents, status, checkout_url, provider_ref, created_at)
      VALUES (${topUp.id}, ${topUp.subject}, ${topUp.amountUsdCents}, ${topUp.status}, ${topUp.checkoutUrl},
              ${topUp.providerRef}, ${topUp.createdAt})
      ON CONFLICT (id) DO NOTHING
    `;
  }

  async attachCheckout(id: string, checkoutUrl: string, providerRef: string) {
    await this.sql`UPDATE mcp_top_ups SET checkout_url = ${checkoutUrl}, provider_ref = ${providerRef} WHERE id = ${id}`;
  }

  async getTopUp(id: string) {
    const [row] = await this.sql<any[]>`SELECT * FROM mcp_top_ups WHERE id = ${id}`;
    return row ? this.toTopUp(row) : null;
  }

  async getTopUpByProviderRef(ref: string) {
    const [row] = await this.sql<any[]>`SELECT * FROM mcp_top_ups WHERE provider_ref = ${ref}`;
    return row ? this.toTopUp(row) : null;
  }

  async updateTopUpStatus(id: string, status: TopUp['status']) {
    await this.sql`UPDATE mcp_top_ups SET status = ${status} WHERE id = ${id}`;
  }

  private toTopUp(row: any): TopUp {
    return {
      id: row.id,
      subject: row.subject,
      amountUsdCents: row.amount_usd_cents,
      status: row.status,
      checkoutUrl: row.checkout_url,
      providerRef: row.provider_ref,
      createdAt: Number(row.created_at),
    };
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
