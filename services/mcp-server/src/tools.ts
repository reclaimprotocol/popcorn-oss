import crypto from 'crypto';
import { McpConfig } from './config';
import { InsufficientCredit, debit, formatUsd, getBalance, refund, validateTopUpAmount } from './credits';
import * as popcorn from './popcorn';
import { createCheckoutSession } from './stripe';
import type { McpStore } from './store';

export type ToolContext = { store: McpStore; subject: string };
export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean; structuredContent?: unknown };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function fail(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data, isError: true };
}

/**
 * Operation-level idempotency. A retried call returns the SAME terminal
 * outcome — it never allocates a second browser, and a retry after a refunded
 * failure does not yield a free session. Charging idempotency alone is not
 * enough, because the debit and the allocation are two different effects.
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

export const TOOL_DEFINITIONS = [
  {
    name: 'get_balance',
    description:
      'Return the caller\'s Popcorn credit balance and the price of one browser session. Popcorn credit is closed-loop: usable only for Popcorn sessions, non-transferable and non-withdrawable.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'top_up',
    description:
      'Add Popcorn credit by card. Returns a Stripe Checkout URL for the human to approve and pay; credit lands on the calling OAuth identity when the payment succeeds. The agent never handles card data.',
    inputSchema: {
      type: 'object',
      properties: {
        amount_usd_cents: { type: 'integer', description: 'Amount to add, in US cents.' },
        reason: { type: 'string', description: 'Human-readable reason shown to the payer.' },
      },
      required: ['amount_usd_cents'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_browser_session',
    description:
      `Start one isolated Popcorn browser session and debit Popcorn credit. One purchase buys one fixed block of ${McpConfig.sessionTtlSeconds} seconds for ${McpConfig.sessionPriceUsdCents} cents; the duration is not negotiable. Returns session id, live-view URL for the human, CDP URL for the agent, expiry, and the amount charged. The browser is fresh and isolated: no local Chrome profile, cookies, or saved passwords.`,
    inputSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: 'What the session is for; shown to the human in approvals and receipts.' },
        idempotency_key: { type: 'string', description: 'Repeat calls with the same key never double-charge.' },
      },
      required: ['purpose'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_browser_session',
    description: 'Fetch the current state of a browser session the caller owns.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_browser_connection',
    description:
      'Return the agent-facing connection details for a session the caller owns: CDP websocket URL, region, and expiry. Free; the session is already paid for.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_live_view',
    description:
      'Return the human-facing live-view URL for a session the caller owns. Send this to the person when a login or human decision is needed; never ask them for credentials.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'verify_runtime',
    description:
      'Return the isolation and attestation posture of a session the caller owns: whether the browser pod is attested, the attestation document when available, and the isolation guarantees that always hold.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'extend_browser_session',
    description: `Extend a session the caller owns by one more fixed block of ${McpConfig.sessionTtlSeconds} seconds. This is the paid boundary: it debits ${McpConfig.extendPriceUsdCents} cents, or returns insufficient_credit with a top_up hint.`,
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
    description: 'End a session the caller owns immediately. Ending early does not refund the session charge.',
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
      const balance = await getBalance(ctx.store, ctx.subject);
      return ok({
        balance_usd_cents: balance,
        balance_display: formatUsd(balance),
        session_price_usd_cents: McpConfig.sessionPriceUsdCents,
        session_block_seconds: McpConfig.sessionTtlSeconds,
        sessions_affordable: Math.floor(balance / Math.max(McpConfig.sessionPriceUsdCents, 1)),
        credit_terms: 'Closed-loop Popcorn credit: usable only for Popcorn browser sessions; non-transferable, non-withdrawable, no crypto.',
      });
    }

    case 'top_up': {
      const amount = Number(args.amount_usd_cents);
      const invalid = validateTopUpAmount(amount);
      if (invalid) return fail({ error: 'invalid_amount', message: invalid });
      const topUpId = crypto.randomUUID();
      // Persist BEFORE calling Stripe: otherwise a webhook that arrives in the
      // gap has no record to match and the payment is silently dropped.
      await ctx.store.putTopUp({
        id: topUpId,
        subject: ctx.subject,
        amountUsdCents: amount,
        status: 'pending',
        checkoutUrl: '',
        providerRef: null,
        createdAt: Date.now(),
      });
      let checkout;
      try {
        checkout = await createCheckoutSession({ subject: ctx.subject, topUpId, amountUsdCents: amount });
      } catch (error) {
        await ctx.store.updateTopUpStatus(topUpId, 'cancelled');
        return fail({ error: 'top_up_unavailable', message: (error as Error).message });
      }
      // Patch the existing row; never rewrite `status`, or a webhook that has
      // already credited this top-up would be knocked back to pending.
      await ctx.store.attachCheckout(topUpId, checkout.url, checkout.id);
      return ok({
        status: 'approval_required',
        top_up_id: topUpId,
        amount_usd_cents: amount,
        amount_display: formatUsd(amount),
        approval_url: checkout.url,
        reason: typeof args.reason === 'string' ? args.reason : 'Popcorn credit',
        next: 'Ask the human to open approval_url and pay. Credit appears on get_balance once Stripe confirms the payment.',
      });
    }

    case 'create_browser_session': {
      const purpose = typeof args.purpose === 'string' ? args.purpose.slice(0, 300) : '';
      if (!purpose) return fail({ error: 'invalid_request', message: 'purpose is required' });
      // Fixed block: the price and the duration are one SKU, so the caller
      // cannot buy unlimited browser time for a single charge.
      const ttlSeconds = McpConfig.sessionTtlSeconds;
      const key = typeof args.idempotency_key === 'string' && args.idempotency_key ? args.idempotency_key : crypto.randomUUID();
      const ref = `session:${ctx.subject}:${key}`;

      const claimed = await claim(ctx, ref);
      if (!claimed.go) return claimed.replay;

      const price = McpConfig.sessionPriceUsdCents;
      try {
        await debit(ctx.store, ctx.subject, price, ref, `browser session: ${purpose}`);
      } catch (error) {
        if (error instanceof InsufficientCredit) {
          // Release the claim: adding credit and retrying the same key must work.
          await ctx.store.releaseOperation(ref);
          return fail({
            error: 'insufficient_credit',
            balance_usd_cents: error.balanceUsdCents,
            required_usd_cents: error.requiredUsdCents,
            next: 'Call top_up to add Popcorn credit, then retry with the same idempotency_key.',
          });
        }
        await ctx.store.releaseOperation(ref);
        throw error;
      }

      const result = await popcorn.createSession({ ttlSeconds, metadata: { subject: ctx.subject, purpose } });
      if (!result.ok) {
        await refund(ctx.store, ctx.subject, price, ref);
        const payload = {
          error: 'session_unavailable',
          message: result.error,
          refunded_usd_cents: price,
          next: 'Retry with a NEW idempotency_key.',
        };
        await settle(ctx, ref, 'failed', payload);
        return fail(payload);
      }

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
        charged_usd_cents: price,
        balance_usd_cents: await getBalance(ctx.store, ctx.subject),
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

      const price = McpConfig.extendPriceUsdCents;
      try {
        await debit(ctx.store, ctx.subject, price, ref, `extend session ${record.sessionId}`);
      } catch (error) {
        await ctx.store.releaseOperation(ref);
        if (error instanceof InsufficientCredit) {
          return fail({
            error: 'insufficient_credit',
            balance_usd_cents: error.balanceUsdCents,
            required_usd_cents: error.requiredUsdCents,
            next: 'Call top_up to add Popcorn credit, then retry with the same idempotency_key.',
          });
        }
        throw error;
      }

      const result = await popcorn.extendSession(record.sessionId, extendBySeconds);
      if (!result.ok) {
        await refund(ctx.store, ctx.subject, price, ref);
        const payload = {
          error: 'extend_failed',
          message: result.error,
          refunded_usd_cents: price,
          next: 'Retry with a NEW idempotency_key.',
        };
        await settle(ctx, ref, 'failed', payload);
        return fail(payload);
      }

      const view = popcorn.toSessionView(result.data);
      if (view.expiresAt) {
        const parsed = Date.parse(view.expiresAt);
        if (Number.isFinite(parsed)) await ctx.store.updateSession(record.sessionId, { expiresAt: parsed });
      }
      const payload = {
        session_id: record.sessionId,
        expires_at: view.expiresAt,
        extended_by_seconds: extendBySeconds,
        charged_usd_cents: price,
        balance_usd_cents: await getBalance(ctx.store, ctx.subject),
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
