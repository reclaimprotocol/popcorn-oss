import crypto from 'crypto';
import { BillingCommitError, type BillingProvider, type UsageContext } from './billing';
import { McpConfig } from './config';
import * as popcorn from './popcorn';
import type { McpStore } from './store';
import { shortenLiveViewUrl } from './url-shortener';

export type ToolContext = { store: McpStore; subject: string; billing: BillingProvider };
export type ToolContent =
  | { type: 'text'; text: string }
  | {
      type: 'resource_link';
      name: string;
      title?: string;
      uri: string;
      description?: string;
      mimeType?: string;
    };
export type ToolResult = {
  content: ToolContent[];
  isError?: boolean;
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
};

const regionItems = {
  type: 'string',
  minLength: 1,
  maxLength: 64,
  ...(McpConfig.availableRegions.length ? { enum: McpConfig.availableRegions } : {}),
};

type ResultOptions = {
  meta?: Record<string, unknown>;
  resourceLinks?: Array<Extract<ToolContent, { type: 'resource_link' }>>;
};

const BROWSER_SESSION_META_KEY = 'org.reclaimprotocol.popcorn/browser-session';
const BROWSER_CONNECTION_META_KEY = 'org.reclaimprotocol.popcorn/browser-connection';
const LIVE_VIEW_META_KEY = 'org.reclaimprotocol.popcorn/live-view';

function jsonText(data: unknown): string {
  // Compact JSON is the backwards-compatible model channel. Avoid pretty
  // printing because signed browser URLs are already long opaque values.
  return JSON.stringify(data) ?? 'null';
}

function ok(data: unknown, options: ResultOptions = {}): ToolResult {
  return {
    content: [{ type: 'text', text: jsonText(data) }, ...(options.resourceLinks ?? [])],
    structuredContent: data,
    ...(options.meta ? { _meta: options.meta } : {}),
  };
}

function fail(data: unknown): ToolResult {
  // With an outputSchema, clients validate structuredContent as the successful
  // shape. Tool failures therefore use the protocol's isError + text channel.
  return { content: [{ type: 'text', text: jsonText(data) }], isError: true };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function liveViewResource(data: Record<string, unknown>): ResultOptions['resourceLinks'] {
  const url = data.live_view_url;
  if (typeof url !== 'string' || !url) return [];
  const sessionId = typeof data.session_id === 'string' ? data.session_id : 'browser';
  return [{
    type: 'resource_link',
    name: `popcorn-live-view-${sessionId}`,
    title: 'Open Popcorn LiveView',
    uri: url,
    description: 'Human-facing view of this isolated browser session.',
    mimeType: 'text/html',
  }];
}

function browserSessionResult(data: unknown): ToolResult {
  const payload = record(data);
  return ok(data, {
    meta: { [BROWSER_SESSION_META_KEY]: payload },
    resourceLinks: liveViewResource(payload),
  });
}

function browserConnectionResult(data: unknown): ToolResult {
  return ok(data, { meta: { [BROWSER_CONNECTION_META_KEY]: record(data) } });
}

function liveViewResult(data: unknown): ToolResult {
  const payload = record(data);
  return ok(data, {
    meta: { [LIVE_VIEW_META_KEY]: payload },
    resourceLinks: liveViewResource(payload),
  });
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
  return {
    go: false,
    replay: existing.outcome === 'succeeded'
      ? browserSessionResult(existing.result)
      : fail(existing.result),
  };
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

type JsonSchema = Record<string, unknown>;

const STRING = { type: 'string' } as const;
const BOOLEAN = { type: 'boolean' } as const;
const NULLABLE_STRING = {
  anyOf: [{ type: 'string' }, { type: 'null' }],
} as const;
const NULLABLE_NUMBER = {
  anyOf: [{ type: 'number' }, { type: 'null' }],
} as const;

function outputSchema(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

function annotations(
  title: string,
  readOnlyHint: boolean,
  destructiveHint = false,
  idempotentHint = true,
) {
  return { title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint: true };
}

const SESSION_ID_INPUT = {
  type: 'object',
  properties: { session_id: { type: 'string', description: 'Popcorn session identifier.' } },
  required: ['session_id'],
  additionalProperties: false,
} as const;

const BROWSER_SESSION_OUTPUT = outputSchema({
  session_id: STRING,
  purpose: STRING,
  live_view_url: NULLABLE_STRING,
  cdp_url: NULLABLE_STRING,
  expires_at: NULLABLE_STRING,
  region: NULLABLE_STRING,
}, ['session_id', 'purpose', 'live_view_url', 'cdp_url', 'expires_at', 'region']);

export const TOOL_DEFINITIONS = [
  {
    name: 'get_balance',
    title: 'Get usage balance',
    description:
      'Return the caller\'s remaining usage credit, if this deployment meters usage. A null balance means usage is not metered here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: outputSchema({
      credits: NULLABLE_NUMBER,
      metered: BOOLEAN,
      session_block_seconds: { type: 'number' },
      credits_per_operation: { type: 'number' },
    }, ['credits', 'metered', 'session_block_seconds', 'credits_per_operation']),
    annotations: annotations('Get usage balance', true),
  },
  {
    name: 'create_browser_session',
    title: 'Create browser session',
    description:
      `Start one isolated Popcorn browser session. One operation buys one fixed block of ${McpConfig.sessionTtlSeconds} seconds; the duration is not negotiable. Prefer a region close to the human to reduce live-view and automation latency. Returns the session id, a human LiveView URL, the agent CDP URL, selected region, and expiry. Treat returned URLs as opaque and pass them unchanged. The browser is fresh and isolated: no local Chrome profile, cookies, or saved passwords.`,
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
    outputSchema: outputSchema({
      session_id: STRING,
      live_view_url: NULLABLE_STRING,
      cdp_url: NULLABLE_STRING,
      expires_at: NULLABLE_STRING,
      region: NULLABLE_STRING,
      proxy_country: NULLABLE_STRING,
      isolation: STRING,
      human_handoff: STRING,
      usage_settled: BOOLEAN,
    }, [
      'session_id',
      'live_view_url',
      'cdp_url',
      'expires_at',
      'region',
      'proxy_country',
      'isolation',
      'human_handoff',
      'usage_settled',
    ]),
    annotations: annotations('Create browser session', false, false, true),
  },
  {
    name: 'get_browser_session',
    title: 'Get browser session',
    description:
      'Return state and connection details for a browser session the caller owns. Treat returned URLs as opaque and pass them unchanged.',
    inputSchema: SESSION_ID_INPUT,
    outputSchema: BROWSER_SESSION_OUTPUT,
    annotations: annotations('Get browser session', true),
  },
  {
    name: 'get_browser_connection',
    title: 'Get browser connection',
    description:
      'Return the exact agent-facing CDP URL, region, and expiry for a session the caller owns. Pass cdp_url unchanged to the browser automation library; do not shorten, decode, re-encode, or reconstruct it.',
    inputSchema: SESSION_ID_INPUT,
    outputSchema: outputSchema({
      session_id: STRING,
      cdp_url: NULLABLE_STRING,
      region: NULLABLE_STRING,
      expires_at: NULLABLE_STRING,
    }, ['session_id', 'cdp_url', 'region', 'expires_at']),
    annotations: annotations('Get browser connection', true),
  },
  {
    name: 'get_live_view',
    title: 'Get LiveView link',
    description:
      'Return a human-facing LiveView link for a session the caller owns. The link is shortened only when the operator explicitly configures a URL-shortener provider; hand the returned link to the human unchanged.',
    inputSchema: SESSION_ID_INPUT,
    outputSchema: outputSchema({
      session_id: STRING,
      live_view_url: NULLABLE_STRING,
      expires_at: NULLABLE_STRING,
      human_handoff: STRING,
    }, ['session_id', 'live_view_url', 'expires_at', 'human_handoff']),
    annotations: annotations('Get LiveView link', true),
  },
  {
    name: 'verify_runtime',
    title: 'Verify browser runtime',
    description: 'Return the isolation posture of a session the caller owns, with an attestation document when the runtime provides one.',
    inputSchema: SESSION_ID_INPUT,
    outputSchema: outputSchema({
      session_id: STRING,
      isolation: STRING,
      attested: BOOLEAN,
      attestation: { description: 'Runtime-specific attestation document, or null.' },
      attestation_error: NULLABLE_STRING,
    }, ['session_id', 'isolation', 'attested', 'attestation', 'attestation_error']),
    annotations: annotations('Verify browser runtime', true),
  },
  {
    name: 'end_browser_session',
    title: 'End browser session',
    description: 'End a session early. Does not return credit for the current block.',
    inputSchema: SESSION_ID_INPUT,
    outputSchema: outputSchema({
      session_id: STRING,
      status: { type: 'string', enum: ['ended'] },
    }, ['session_id', 'status']),
    annotations: annotations('End browser session', false, true, true),
  },
  {
    name: 'list_browser_sessions',
    title: 'List browser sessions',
    description: 'List recent browser sessions belonging to the caller.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max sessions to return (default 20).' },
      },
      additionalProperties: false,
    },
    outputSchema: outputSchema({
      sessions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            session_id: STRING,
            purpose: STRING,
            created_at: STRING,
            expires_at: NULLABLE_STRING,
            ended_at: NULLABLE_STRING,
          },
          required: ['session_id', 'purpose', 'created_at', 'expires_at', 'ended_at'],
          additionalProperties: false,
        },
      },
    }, ['sessions']),
    annotations: annotations('List browser sessions', true),
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
      const liveViewUrl = await shortenLiveViewUrl(view.liveViewUrl);
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
        live_view_url: liveViewUrl,
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
      return browserSessionResult(payload);
    }

    case 'get_browser_session': {
      const record = await ownedSession(ctx, args.session_id);
      if (!record) return fail({ error: 'not_found', message: 'no such session for this identity' });
      const result = await popcorn.getSession(record.sessionId);
      if (!result.ok) return fail({ error: 'session_unavailable', message: result.error });
      const view = popcorn.toSessionView(result.data);
      const liveViewUrl = await shortenLiveViewUrl(view.liveViewUrl);
      return browserSessionResult({
        session_id: view.sessionId,
        purpose: record.purpose,
        live_view_url: liveViewUrl,
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
      return browserConnectionResult({
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
      const liveViewUrl = await shortenLiveViewUrl(liveView.liveViewUrl);
      return liveViewResult({
        session_id: record.sessionId,
        live_view_url: liveViewUrl,
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
