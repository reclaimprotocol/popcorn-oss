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
      'Start one isolated Popcorn browser session and debit Popcorn credit. Returns session id, live-view URL for the human, CDP URL for the agent, expiry, and the amount charged. The browser is fresh and isolated: no local Chrome profile, cookies, or saved passwords.',
    inputSchema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', description: 'What the session is for; shown to the human in approvals and receipts.' },
        ttl_seconds: { type: 'integer', description: `Requested lifetime in seconds (default ${McpConfig.sessionTtlSeconds}).` },
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
    name: 'extend_browser_session',
    description: 'Extend a session the caller owns. This is the paid boundary: it debits credit, or returns insufficient_credit with a top_up hint.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        ttl_seconds: { type: 'integer' },
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
        sessions_affordable: Math.floor(balance / Math.max(McpConfig.sessionPriceUsdCents, 1)),
        credit_terms: 'Closed-loop Popcorn credit: usable only for Popcorn browser sessions; non-transferable, non-withdrawable, no crypto.',
      });
    }

    case 'top_up': {
      const amount = Number(args.amount_usd_cents);
      const invalid = validateTopUpAmount(amount);
      if (invalid) return fail({ error: 'invalid_amount', message: invalid });
      const topUpId = crypto.randomUUID();
      let checkout;
      try {
        checkout = await createCheckoutSession({ subject: ctx.subject, topUpId, amountUsdCents: amount });
      } catch (error) {
        return fail({ error: 'top_up_unavailable', message: (error as Error).message });
      }
      await ctx.store.putTopUp({
        id: topUpId,
        subject: ctx.subject,
        amountUsdCents: amount,
        status: 'pending',
        checkoutUrl: checkout.url,
        providerRef: checkout.id,
        createdAt: Date.now(),
      });
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
      const ttlSeconds = Number.isInteger(args.ttl_seconds) ? Number(args.ttl_seconds) : McpConfig.sessionTtlSeconds;
      const ref = `session:${ctx.subject}:${typeof args.idempotency_key === 'string' && args.idempotency_key ? args.idempotency_key : crypto.randomUUID()}`;
      const price = McpConfig.sessionPriceUsdCents;
      try {
        await debit(ctx.store, ctx.subject, price, ref, `browser session: ${purpose}`);
      } catch (error) {
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

      const result = await popcorn.createSession({ ttlSeconds, metadata: { subject: ctx.subject, purpose } });
      if (!result.ok) {
        await refund(ctx.store, ctx.subject, price, ref);
        return fail({ error: 'session_unavailable', message: result.error, refunded_usd_cents: price });
      }

      const session = result.data;
      const expiresAt = typeof session.expiresAt === 'string' ? Date.parse(session.expiresAt) : null;
      await ctx.store.putSession({
        sessionId: session.sessionId,
        subject: ctx.subject,
        purpose,
        createdAt: Date.now(),
        expiresAt: Number.isFinite(expiresAt) ? (expiresAt as number) : null,
        endedAt: null,
      });
      return ok({
        session_id: session.sessionId,
        live_view_url: session.liveViewUrl,
        cdp_url: session.cdpUrl,
        expires_at: session.expiresAt,
        region: session.region,
        charged_usd_cents: price,
        balance_usd_cents: await getBalance(ctx.store, ctx.subject),
        isolation: 'Fresh isolated browser. No local Chrome profile, cookies, or saved passwords are used.',
        human_handoff: 'Send live_view_url to the human for any login; do not ask them for credentials.',
      });
    }

    case 'get_browser_session': {
      const record = await ownedSession(ctx, args.session_id);
      if (!record) return fail({ error: 'not_found', message: 'no such session for this identity' });
      const result = await popcorn.getSession(record.sessionId);
      if (!result.ok) return fail({ error: 'session_unavailable', message: result.error });
      return ok({ ...result.data, purpose: record.purpose });
    }

    case 'extend_browser_session': {
      const record = await ownedSession(ctx, args.session_id);
      if (!record) return fail({ error: 'not_found', message: 'no such session for this identity' });
      const ttlSeconds = Number.isInteger(args.ttl_seconds) ? Number(args.ttl_seconds) : McpConfig.sessionTtlSeconds;
      const ref = `extend:${record.sessionId}:${typeof args.idempotency_key === 'string' && args.idempotency_key ? args.idempotency_key : crypto.randomUUID()}`;
      const price = McpConfig.extendPriceUsdCents;
      try {
        await debit(ctx.store, ctx.subject, price, ref, `extend session ${record.sessionId}`);
      } catch (error) {
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
      const result = await popcorn.extendSession(record.sessionId, ttlSeconds);
      if (!result.ok) {
        await refund(ctx.store, ctx.subject, price, ref);
        return fail({ error: 'extend_failed', message: result.error, refunded_usd_cents: price });
      }
      return ok({
        session_id: record.sessionId,
        expires_at: result.data.expiresAt,
        charged_usd_cents: price,
        balance_usd_cents: await getBalance(ctx.store, ctx.subject),
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
