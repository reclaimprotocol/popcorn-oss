import crypto from 'crypto';
import { BillingCommitError, type BillingProvider, type UsageContext } from './billing';
import { McpConfig } from './config';
import * as popcorn from './popcorn';
import type { McpStore } from './store';

export type ToolContext = { store: McpStore; subject: string; billing: BillingProvider };
export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean; structuredContent?: unknown };

const regionItems = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  ...(McpConfig.availableRegions.length ? { enum: McpConfig.availableRegions } : {}),
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function fail(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: true };
}

/**
 * Operation-level idempotency. This server performs the browser effect, so it
 * owns operation recovery: a retried call replays the SAME terminal outcome
 * rather than allocating a second browser, and a retry after a released
 * reservation cannot yield a free session.
 */
async function claim(ctx: ToolContext, ref: string): Promise<{ go: true } | { go: false; replay: ToolResult }> {
  const { claimed, existing } = await ctx.store.claimOperation(
    ref,
    ctx.subject,
    McpConfig.operationLeaseSeconds * 1000,
  );
  if (claimed) return { go: true };
  if (!existing || existing.outcome === 'pending') {
    // Another call with this key is in flight; do NOT start a second effect.
    return {
      go: false,
      replay: fail({
        error: 'operation_in_progress',
        message: 'Another call with this idempotency_key is still running.',
        next: 'Poll with the same idempotency_key, or use list_browser_sessions.',
      }),
    };
  }
  return { go: false, replay: existing.outcome === 'succeeded' ? ok(existing.result) : fail(existing.result) };
}

/** Stable Control Plane id: a stale operation can safely discover/replay its browser. */
export function sessionIdForOperation(ref: string): string {
  return `mcp_${crypto.createHash('sha256').update(ref).digest('base64url')}`;
}

function idempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return key && key.length <= 200 ? key : null;
}

async function settle(ctx: ToolContext, ref: string, outcome: 'succeeded' | 'failed', result: unknown) {
  await ctx.store.settleOperation(ref, outcome, result);
}

/**
 * Reserve usage credit for an operation. On refusal the operation claim is
 * released so the caller can retry the SAME key after obtaining credit, and
 * the provider's `nextAction` is passed through opaquely — this server never
 * interprets it and never names a payment provider.
 */
async function reserveOrExplain(
  ctx: ToolContext,
  ref: string,
  context: UsageContext,
): Promise<{ ok: true; reservationId: string } | { ok: false; result: ToolResult }> {
  const reservation = await ctx.billing.reserve(context);
  if (reservation.ok) return { ok: true, reservationId: reservation.reservationId };

  await ctx.store.releaseOperation(ref);
  if (reservation.reason === 'billing_unavailable') {
    return {
      ok: false,
      result: fail({
        error: 'billing_unavailable',
        message: 'Usage credit could not be checked right now.',
        next: 'Retry shortly with the same idempotency_key.',
      }),
    };
  }
  return {
    ok: false,
    result: fail({
      error: 'insufficient_credit',
      message: 'Not enough usage credit for this operation.',
      ...(reservation.nextAction ? { next_action: reservation.nextAction } : {}),
      next: reservation.nextAction
        ? 'Give the human next_action to obtain more credit, then retry with the same idempotency_key.'
        : 'Obtain more usage credit, then retry with the same idempotency_key.',
    }),
  };
}

/**
 * Settle a reservation for an effect that ALREADY happened.
 *
 * The browser exists by the time we get here, so the credit is owed. We record
 * the obligation durably BEFORE attempting the commit: if this process dies,
 * or billing is down, or the commit times out, the reconciler retries it. A
 * commit that merely looks like it failed is safe to retry, because commit is
 * idempotent on the provider side.
 *
 * Returns whether billing confirmed the settlement, so the operation result
 * never claims to be fully settled when it is not.
 */
async function settleUsage(
  ctx: ToolContext,
  reservationId: string,
  operationRef: string,
  operation: UsageContext['operation'],
): Promise<boolean> {
  await ctx.store.putPendingCommit({
    reservationId,
    subject: ctx.subject,
    operationRef,
    operation,
    attempts: 0,
    lastError: null,
    createdAt: Date.now(),
    nextAttemptAt: Date.now(),
  });
  try {
    await ctx.billing.commit(reservationId);
    await ctx.store.deletePendingCommit(reservationId);
    return true;
  } catch (error) {
    const message = error instanceof BillingCommitError ? error.message : String(error);
    if (error instanceof BillingCommitError && error.terminal) {
      // Retrying can never work. Drop the obligation but make the loss loud:
      // an operation was delivered that billing refused to settle.
      console.error(`UNSETTLED USAGE: commit permanently refused for ${reservationId} (${operationRef}): ${message}`);
      await ctx.store.deletePendingCommit(reservationId);
      return false;
    }
    console.error(`commit deferred for ${reservationId} (${operationRef}): ${message}`);
    await ctx.store.recordCommitAttempt(reservationId, message, Date.now() + 30_000);
    return false;
  }
}

export const TOOL_DEFINITIONS = [
  {
    name: 'get_balance',
    description:
      'Return the caller\'s remaining usage credit, if this deployment meters usage. A null balance means usage is not metered here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_browser_session',
    description:
      `Start one isolated Popcorn browser session. One operation buys one fixed block of ${McpConfig.sessionTtlSeconds} seconds; the duration is not negotiable. Prefer a region close to the human to reduce live-view and automation latency. Returns session id, live-view URL for the human, CDP URL for the agent, selected region, and expiry. The browser is fresh and isolated: no local Chrome profile, cookies, or saved passwords.`,
    inputSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: 'What this session is for (shown to the human).' },
        idempotency_key: {
          type: 'string',
          description: 'Reuse the same key when retrying: you get back the same session, never a second one.',
        },
        regions: {
          type: 'array',
          minItems: 1,
          maxItems: 8,
          items: regionItems,
          description:
            `Optional Popcorn region names ordered closest-to-human first; later entries are allocation fallbacks. Omit to use the deployment default order.${McpConfig.availableRegions.length ? ` Available regions: ${McpConfig.availableRegions.join(', ')}.` : ''}`,
        },
        proxy_country: {
          type: 'string',
          pattern: '^[A-Za-z]{2}$',
          description:
            'Optional ISO 3166-1 alpha-2 country code for a deployment-managed proxy exit (for example US or IN). This selects a country, never a proxy URL.',
        },
      },
      required: ['purpose', 'idempotency_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_browser_session',
    description: 'State of a browser session the caller owns.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_browser_connection',
    description: 'Agent-facing connection details (CDP URL, region, expiry) for a session the caller owns.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_live_view',
    description: 'Human-facing live-view URL for a session the caller owns; use it to hand a login to the human.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'verify_runtime',
    description: 'Isolation posture of a session the caller owns, with an attestation document when the runtime provides one.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'end_browser_session',
    description: 'End a session early. Does not return credit for the current block.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_browser_sessions',
    description: 'List recent browser sessions belonging to the caller.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max sessions to return (default 20).' } },
      additionalProperties: false,
    },
  },
] as const;

async function ownedSession(ctx: ToolContext, sessionId: unknown) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const record = await ctx.store.getSession(sessionId);
  if (!record || record.subject !== ctx.subject) return null;
  return record;
}

export async function callTool(ctx: ToolContext, name: string, args: Record<string, any>): Promise<ToolResult> {
  switch (name) {
    case 'get_balance': {
      const balance = await ctx.billing.getBalance(ctx.subject);
      return ok({
        credits: balance,
        metered: balance !== null,
        session_block_seconds: McpConfig.sessionTtlSeconds,
        credits_per_operation: 1,
      });
    }

    case 'create_browser_session': {
      const purpose = typeof args.purpose === 'string' ? args.purpose.slice(0, 300) : '';
      if (!purpose) return fail({ error: 'invalid_request', message: 'purpose is required' });
      const key = idempotencyKey(args.idempotency_key);
      if (!key) return fail({ error: 'invalid_request', message: 'idempotency_key is required (max 200 characters)' });
      let regions: string[] | undefined;
      if (args.regions !== undefined) {
        if (!Array.isArray(args.regions) || args.regions.length < 1 || args.regions.length > 8
          || args.regions.some((region: unknown) => typeof region !== 'string' || !region.trim() || region.trim().length > 64)) {
          return fail({
            error: 'invalid_request',
            message: 'regions must contain 1-8 Popcorn region names ordered nearest-first',
          });
        }
        regions = [...new Set(args.regions.map((region: string) => region.trim()))];
        const unknown = regions.find((region) => McpConfig.availableRegions.length
          && !McpConfig.availableRegions.includes(region));
        if (unknown) {
          return fail({
            error: 'invalid_request',
            message: `unknown region: ${unknown}`,
            available_regions: McpConfig.availableRegions,
          });
        }
      }
      let proxyCountry: string | undefined;
      if (args.proxy_country !== undefined) {
        if (typeof args.proxy_country !== 'string' || !/^[A-Za-z]{2}$/.test(args.proxy_country.trim())) {
          return fail({ error: 'invalid_request', message: 'proxy_country must be a two-letter ISO country code' });
        }
        proxyCountry = args.proxy_country.trim().toUpperCase();
      }
      const ref = `session:${ctx.subject}:${key}`;
      const sessionId = sessionIdForOperation(ref);

      const claimed = await claim(ctx, ref);
      if (!claimed.go) return claimed.replay;

      const reserved = await reserveOrExplain(ctx, ref, {
        subject: ctx.subject,
        operationId: ref,
        operation: 'create_session',
      });
      if (!reserved.ok) return reserved.result;

      let result = await popcorn.createSession({
        sessionId,
        ttlSeconds: McpConfig.sessionTtlSeconds,
        metadata: { subject: ctx.subject, purpose },
        regions,
        proxyCountry,
      });
      // A recovered operation uses the same deterministic id. The normal API
      // reports the already-created effect as 409, so fetch and replay it.
      if (!result.ok && result.status === 409) result = await popcorn.getSession(sessionId);
      if (!result.ok) {
        await ctx.billing.release(reserved.reservationId);
        const payload = {
          error: 'session_unavailable',
          message: result.error,
          next: 'Retry with a NEW idempotency_key.',
        };
        await settle(ctx, ref, 'failed', payload);
        return fail(payload);
      }
      const settled = await settleUsage(ctx, reserved.reservationId, ref, 'create_session');

      const view = popcorn.toSessionView(result.data);
      const expiresAt = view.expiresAt ? Date.parse(view.expiresAt) : NaN;
      await ctx.store.putSession({
        sessionId: view.sessionId,
        subject: ctx.subject,
        purpose,
        createdAt: Date.now(),
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
        endedAt: null,
      });
      const payload = {
        session_id: view.sessionId,
        live_view_url: view.liveViewUrl,
        cdp_url: view.agentCdpUrl,
        expires_at: view.expiresAt,
        region: view.region,
        proxy_country: proxyCountry ?? null,
        isolation: 'Fresh isolated browser. No local Chrome profile, cookies, or saved passwords.',
        human_handoff: 'Send live_view_url to the human for any login; do not ask them for credentials.',
        // False means the session is live but its usage has not been confirmed
        // settled yet; reconciliation will retry.
        usage_settled: settled,
      };
      await settle(ctx, ref, 'succeeded', payload);
      return ok(payload);
    }

    case 'get_browser_session': {
      const record = await ownedSession(ctx, args.session_id);
      if (!record) return fail({ error: 'not_found', message: 'no such session for this identity' });
      const result = await popcorn.getSession(record.sessionId);
      if (!result.ok) return fail({ error: 'session_unavailable', message: result.error });
      const view = popcorn.toSessionView(result.data);
      return ok({
        session_id: view.sessionId,
        purpose: record.purpose,
        live_view_url: view.liveViewUrl,
        cdp_url: view.agentCdpUrl,
        expires_at: view.expiresAt,
        region: view.region,
      });
    }

    case 'get_browser_connection': {
      const record = await ownedSession(ctx, args.session_id);
      if (!record) return fail({ error: 'not_found', message: 'no such session for this identity' });
      const result = await popcorn.getSession(record.sessionId);
      if (!result.ok) return fail({ error: 'session_unavailable', message: result.error });
      const connection = popcorn.toSessionView(result.data);
      return ok({
        session_id: record.sessionId,
        cdp_url: connection.agentCdpUrl,
        region: connection.region,
        expires_at: connection.expiresAt,
      });
    }

    case 'get_live_view': {
      const record = await ownedSession(ctx, args.session_id);
      if (!record) return fail({ error: 'not_found', message: 'no such session for this identity' });
      const result = await popcorn.getSession(record.sessionId);
      if (!result.ok) return fail({ error: 'session_unavailable', message: result.error });
      const liveView = popcorn.toSessionView(result.data);
      return ok({
        session_id: record.sessionId,
        live_view_url: liveView.liveViewUrl,
        expires_at: liveView.expiresAt,
        human_handoff: 'Send this URL to the human for any login. Do not ask them for credentials.',
      });
    }

    case 'verify_runtime': {
      const record = await ownedSession(ctx, args.session_id);
      if (!record) return fail({ error: 'not_found', message: 'no such session for this identity' });
      const attestation = await popcorn.getSessionAttestation(record.sessionId);
      return ok({
        session_id: record.sessionId,
        isolation: 'Dedicated ephemeral browser pod. No local Chrome profile, cookies, or saved passwords; storage is destroyed when the session ends.',
        attested: attestation.ok,
        attestation: attestation.ok ? attestation.data : null,
        attestation_error: attestation.ok ? null : attestation.error,
      });
    }

    case 'end_browser_session': {
      const record = await ownedSession(ctx, args.session_id);
      if (!record) return fail({ error: 'not_found', message: 'no such session for this identity' });
      const result = await popcorn.endSession(record.sessionId);
      if (!result.ok) return fail({ error: 'end_failed', message: result.error });
      await ctx.store.updateSession(record.sessionId, { endedAt: Date.now() });
      return ok({ session_id: record.sessionId, status: 'ended' });
    }

    case 'list_browser_sessions': {
      const limit = Number.isInteger(args.limit) ? Math.min(Number(args.limit), 100) : 20;
      const sessions = await ctx.store.listSessions(ctx.subject, limit);
      return ok({
        sessions: sessions.map((session) => ({
          session_id: session.sessionId,
          purpose: session.purpose,
          created_at: new Date(session.createdAt).toISOString(),
          expires_at: session.expiresAt ? new Date(session.expiresAt).toISOString() : null,
          ended_at: session.endedAt ? new Date(session.endedAt).toISOString() : null,
        })),
      });
    }

    default:
      return fail({ error: 'unknown_tool', message: `no tool named ${name}` });
  }
}
