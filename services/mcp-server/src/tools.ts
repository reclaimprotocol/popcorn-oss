import crypto from 'crypto';
import type { BillingProvider, UsageContext } from './billing';
import { McpConfig } from './config';
import * as popcorn from './popcorn';
import type { McpStore } from './store';

export type ToolContext = { store: McpStore; subject: string; billing: BillingProvider };
export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean; structuredContent?: unknown };

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
  const { claimed, existing } = await ctx.store.claimOperation(ref, ctx.subject);
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
      `Start one isolated Popcorn browser session. One operation buys one fixed block of ${McpConfig.sessionTtlSeconds} seconds; the duration is not negotiable. Returns session id, live-view URL for the human, CDP URL for the agent, and expiry. The browser is fresh and isolated: no local Chrome profile, cookies, or saved passwords.`,
    inputSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: 'What this session is for (shown to the human).' },
        idempotency_key: {
          type: 'string',
          description: 'Reuse the same key when retrying: you get back the same session, never a second one.',
        },
      },
      required: ['purpose'],
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
    name: 'extend_browser_session',
    description: `Extend a session the caller owns by one more fixed block of ${McpConfig.sessionTtlSeconds} seconds. This is a billed operation.`,
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        idempotency_key: { type: 'string' },
      },
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
      const key = typeof args.idempotency_key === 'string' && args.idempotency_key ? args.idempotency_key : crypto.randomUUID();
      const ref = `session:${ctx.subject}:${key}`;

      const claimed = await claim(ctx, ref);
      if (!claimed.go) return claimed.replay;

      const reserved = await reserveOrExplain(ctx, ref, {
        subject: ctx.subject,
        operationId: ref,
        operation: 'create_session',
      });
      if (!reserved.ok) return reserved.result;

      const result = await popcorn.createSession({
        ttlSeconds: McpConfig.sessionTtlSeconds,
        metadata: { subject: ctx.subject, purpose },
      });
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
      await ctx.billing.commit(reserved.reservationId);

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
        cdp_url: view.cdpUrl,
        expires_at: view.expiresAt,
        region: view.region,
        isolation: 'Fresh isolated browser. No local Chrome profile, cookies, or saved passwords.',
        human_handoff: 'Send live_view_url to the human for any login; do not ask them for credentials.',
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
        cdp_url: view.cdpUrl,
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
        cdp_url: connection.cdpUrl,
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

    case 'extend_browser_session': {
      const record = await ownedSession(ctx, args.session_id);
      if (!record) return fail({ error: 'not_found', message: 'no such session for this identity' });
      const extendBySeconds = McpConfig.sessionTtlSeconds;
      const key = typeof args.idempotency_key === 'string' && args.idempotency_key ? args.idempotency_key : crypto.randomUUID();
      const ref = `extend:${record.sessionId}:${key}`;

      const claimed = await claim(ctx, ref);
      if (!claimed.go) return claimed.replay;

      const reserved = await reserveOrExplain(ctx, ref, {
        subject: ctx.subject,
        operationId: ref,
        operation: 'extend_session',
      });
      if (!reserved.ok) return reserved.result;

      const result = await popcorn.extendSession(record.sessionId, extendBySeconds);
      if (!result.ok) {
        await ctx.billing.release(reserved.reservationId);
        const payload = {
          error: 'extend_failed',
          message: result.error,
          next: 'Retry with a NEW idempotency_key.',
        };
        await settle(ctx, ref, 'failed', payload);
        return fail(payload);
      }
      await ctx.billing.commit(reserved.reservationId);

      const view = popcorn.toSessionView(result.data);
      if (view.expiresAt) {
        const parsed = Date.parse(view.expiresAt);
        if (Number.isFinite(parsed)) await ctx.store.updateSession(record.sessionId, { expiresAt: parsed });
      }
      const payload = {
        session_id: record.sessionId,
        expires_at: view.expiresAt,
        extended_by_seconds: extendBySeconds,
      };
      await settle(ctx, ref, 'succeeded', payload);
      return ok(payload);
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
