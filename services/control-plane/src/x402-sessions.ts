import crypto from 'node:crypto';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import type { RegionConfig, X402Config } from './config';
import {
  activateRegionalSessionAccess,
  allocateInRegion,
  deleteRegionalSession,
  extendRegionalSessionTtl,
  getRegionalSession,
  reallocateExpiredRegionalSession,
} from './pool-manager';
import { SessionService } from './sessions';
import { X402PaymentError, X402PaymentGateway, type X402Offer, type VerifiedX402Payment, x402UsdcAddress } from './x402-payment';
import { X402ClaimBusyError, X402Store, type X402PaymentRow, type X402SessionRow } from './x402-store';
import {
  decryptX402SettlementRequest,
  deriveSessionCapability,
  encryptX402SettlementRequest,
  hasX402ExtensionActivationWindow,
  isOwnedPublicX402Session,
  publicX402SessionUrl,
  publicX402Endpoints,
} from './x402-utils';
import type { X402LeaseGuard } from './x402-coordination';
import { recoverInterruptedExtension, runCleanupAttempt } from './x402-recovery';
import {
  createAuthorizationChainReader,
  inspectAuthorizationOutcome,
  type AuthorizationChainReader,
} from './x402-chain';

const PUBLIC_X402_CLIENT_ID = 'x402-public';
const PUBLIC_X402_CLIENT_NAME = 'Public x402';

export interface X402HttpResult {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface X402RequestInput {
  idempotencyKey?: string;
  paymentSignature?: string;
  resourceUrl: string;
}

interface X402Dependencies {
  config: X402Config;
  regions: RegionConfig[];
  serviceAuthToken: string;
  gateway: X402PaymentGateway;
  chainReader?: AuthorizationChainReader;
}

class X402SettlementFailure extends Error {
  constructor(message: string, public readonly result?: SettleResponse) {
    super(message);
  }
}

class X402SettlementAmbiguous extends Error {
  constructor(message: string, public readonly result?: SettleResponse) {
    super(message);
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const TERMINAL_SETTLEMENT_REASONS = new Set([
  'invalid_exact_evm_scheme',
  'invalid_exact_evm_network_mismatch',
  'invalid_exact_evm_missing_eip712_domain',
  'invalid_exact_evm_recipient_mismatch',
  'invalid_exact_evm_signature',
  'invalid_exact_evm_payload_authorization_valid_before',
  'invalid_exact_evm_payload_authorization_valid_after',
  'invalid_exact_evm_authorization_value',
  'invalid_exact_evm_payload_authorization_value_mismatch',
  'invalid_exact_evm_token_name_mismatch',
  'invalid_exact_evm_token_version_mismatch',
  'invalid_exact_evm_eip3009_not_supported',
  'invalid_exact_evm_insufficient_balance',
  'asset_not_deployed_contract',
]);

function requestHash(value: Record<string, unknown>): string {
  return sha256(JSON.stringify(value));
}

function secretHashMatches(value: string | undefined, expectedHash: string | null | undefined): boolean {
  if (!value || !expectedHash) return false;
  const actual = Buffer.from(sha256(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function readIdempotencyKey(value: string | undefined): { value?: string; error?: string } {
  const key = value?.trim();
  if (!key) return { error: 'Idempotency-Key header is required' };
  if (key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    return { error: 'Idempotency-Key must be 1-128 characters in [A-Za-z0-9._:-]' };
  }
  return { value: key };
}

function paymentRequired(offer: X402Offer, error = 'Payment required'): X402HttpResult {
  return {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': offer.header },
    body: { error },
  };
}

function getMetadata(session: { metadata?: unknown } | undefined): Record<string, unknown> {
  return session?.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};
}

interface ExtensionRecoveryState {
  region: string;
  previousExpiresAt: string;
  previousPaidBlocks: number;
  previousMetadata: Record<string, unknown>;
  previousEndpoints: { liveViewUrl?: string; connectUrl?: string };
}

function readExtensionRecovery(value: unknown): ExtensionRecoveryState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const recovery = value as Record<string, unknown>;
  if (typeof recovery.region !== 'string' || typeof recovery.previousExpiresAt !== 'string'
    || !Number.isInteger(recovery.previousPaidBlocks) || (recovery.previousPaidBlocks as number) <= 0
    || !recovery.previousMetadata || typeof recovery.previousMetadata !== 'object'
    || Array.isArray(recovery.previousMetadata)) return null;
  const endpoints = recovery.previousEndpoints;
  return {
    region: recovery.region,
    previousExpiresAt: recovery.previousExpiresAt,
    previousPaidBlocks: recovery.previousPaidBlocks as number,
    previousMetadata: recovery.previousMetadata as Record<string, unknown>,
    previousEndpoints: endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints)
      ? endpoints as ExtensionRecoveryState['previousEndpoints'] : {},
  };
}

function endpointMetadata(session: { metadata?: unknown } | undefined, publicGatewayUrl: string, sessionId: string): { liveViewUrl?: string; connectUrl?: string } {
  const endpoints = getMetadata(session).x402PublicEndpoints;
  return endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints)
    ? publicX402Endpoints({
      url: (endpoints as Record<string, unknown>).liveViewUrl,
      cdpUrl: (endpoints as Record<string, unknown>).connectUrl,
    }, publicGatewayUrl, sessionId)
    : {};
}

function publicSessionResponse(
  body: Record<string, unknown>,
  config: X402Config,
  internalSessionId: string,
): Record<string, unknown> {
  const capability = deriveSessionCapability(config.serverSecret!, internalSessionId);
  return {
    ...body,
    sessionId: capability,
    sessionUrl: publicX402SessionUrl(config.publicBaseUrl!, capability),
  };
}

function replaySettled(payment: X402PaymentRow, config: X402Config): X402HttpResult | null {
  if (payment.status !== 'settled' || !payment.response || !payment.settlementResponse || !payment.sessionId) return null;
  const body = payment.response as Record<string, unknown>;
  const settlement = payment.settlementResponse as SettleResponse;
  const gateway = new X402PaymentGateway(config);
  return {
    status: 200,
    headers: { 'PAYMENT-RESPONSE': gateway.settlementHeader(settlement) },
    body: publicSessionResponse(body, config, payment.sessionId),
  };
}

function findDedicatedRegion(config: X402Config, regions: RegionConfig[]): RegionConfig | null {
  const matches = regions.filter((region) => region.name === config.regionName && region.enabled);
  return matches.length === 1 && matches[0]?.x402Only === true ? matches[0] : null;
}

async function reserveAndOffer(input: {
  deps: X402Dependencies;
  operation: 'create' | 'extend';
  sessionId?: string;
  blocks: number;
  idempotencyKey: string;
  requestHash: string;
  resourceUrl: string;
  paymentSignature?: string;
}): Promise<{ payment: X402PaymentRow; offer: X402Offer } | X402HttpResult> {
  const { config } = input.deps;
  const payment = await X402Store.reservePayment({
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    operation: input.operation,
    sessionId: input.sessionId,
    network: config.network,
    asset: x402UsdcAddress(config.network),
    amountAtomic: String(input.blocks * config.pricePerBlockAtomic),
    payTo: config.payTo!,
    blocks: input.blocks,
    facilitatorUrl: config.facilitatorUrl,
  });
  if (payment.requestHash !== input.requestHash) {
    return { status: 409, body: { error: 'Idempotency-Key was already used for a different request' } };
  }
  const replay = replaySettled(payment, config);
  if (replay) {
    // A create idempotency key is not a credential. Releasing the capability
    // requires possession of the exact paid request as well.
    if (input.operation === 'create'
      && !secretHashMatches(input.paymentSignature, payment.paymentSignatureHash)) {
      return { status: 409, body: { error: 'Settled create replay requires the original PAYMENT-SIGNATURE' } };
    }
    return replay;
  }
  if (['operation_pending', 'settlement_pending', 'reconciliation_required', 'extension_recovery_required']
    .includes(payment.status)) {
    return {
      status: 503,
      headers: { 'Retry-After': '5' },
      body: { error: 'Payment settlement is awaiting durable reconciliation; retry this idempotency key shortly' },
    };
  }

  let offer: X402Offer;
  try {
    offer = await input.deps.gateway.createOffer({
      blocks: input.blocks,
      resourceUrl: new URL(
        input.operation === 'create'
          ? '/v1/x402/sessions'
          : `/v1/x402/sessions/${encodeURIComponent(input.sessionId!)}/extend`,
        `${config.publicBaseUrl}/`,
      ).toString(),
      description: input.operation === 'create'
        ? 'Start a Popcorn browser session for 5 minutes'
        : `Extend a Popcorn browser session by ${input.blocks * 5} minutes`,
    });
  } catch (error) {
    console.error('x402 facilitator initialization failed:', error);
    return { status: 503, body: { error: 'x402 payment service is unavailable' } };
  }
  return { payment, offer };
}

async function verifyAndReservePayload(input: {
  deps: X402Dependencies;
  payment: X402PaymentRow;
  offer: X402Offer;
  signature?: string;
}): Promise<VerifiedX402Payment | X402HttpResult> {
  if (!input.signature) {
    await X402Store.addEvent({
      paymentId: input.payment.id,
      sessionId: input.payment.sessionId || undefined,
      eventType: 'x402.challenge_issued',
      metadata: { operation: input.payment.operation, amountAtomic: input.payment.amountAtomic },
    });
    return paymentRequired(input.offer);
  }

  let verified: VerifiedX402Payment;
  try {
    verified = await input.deps.gateway.verify(input.signature, input.offer);
  } catch (error) {
    const paymentError = error instanceof X402PaymentError ? error : null;
    await X402Store.updatePayment(input.payment.id, {
      status: 'verification_failed',
      failureReason: paymentError?.reason || (error as Error).message,
    });
    await X402Store.addEvent({
      paymentId: input.payment.id,
      sessionId: input.payment.sessionId || undefined,
      eventType: 'x402.payment_failed',
      metadata: { phase: 'verify', reason: paymentError?.reason || 'facilitator_error' },
    });
    return paymentRequired(input.offer, paymentError?.message || 'Payment verification failed');
  }

  const used = await X402Store.findPaymentByPayloadHash(verified.payloadHash);
  if (used && used.id !== input.payment.id) {
    return { status: 409, body: { error: 'This payment authorization was already used' } };
  }
  try {
    await X402Store.updatePayment(input.payment.id, {
      paymentPayloadHash: verified.payloadHash,
      paymentSignatureHash: sha256(input.signature),
      payerWallet: verified.payer,
      asset: verified.requirements.asset,
      status: 'verified',
      failureReason: null,
    });
  } catch {
    return { status: 409, body: { error: 'This payment authorization was already used' } };
  }
  await X402Store.addEvent({
    paymentId: input.payment.id,
    sessionId: input.payment.sessionId || undefined,
    eventType: 'x402.payment_verified',
    metadata: { payerWallet: verified.payer, amountAtomic: input.payment.amountAtomic },
  });
  return verified;
}

async function settle(input: {
  deps: X402Dependencies;
  payment: X402PaymentRow;
  offer: X402Offer;
  verified: VerifiedX402Payment;
}): Promise<SettleResponse> {
  let result: SettleResponse;
  try {
    result = await input.deps.gateway.settle(input.verified, input.offer);
  } catch (error) {
    await X402Store.updatePayment(input.payment.id, {
      status: 'reconciliation_required',
      failureReason: `Ambiguous settlement transport failure: ${(error as Error).message}`,
    }).catch(() => null);
    await X402Store.addEvent({
      paymentId: input.payment.id,
      sessionId: input.payment.sessionId || undefined,
      eventType: 'x402.settlement_ambiguous',
      metadata: { reason: (error as Error).message },
    }).catch(() => null);
    throw new X402SettlementAmbiguous((error as Error).message);
  }

  if (result.success) return result;
  const reason = result.errorReason || result.errorMessage || 'Payment settlement failed';
  // A false response can still follow a successful broadcast (for example,
  // "nonce already used"). Only pre-broadcast validation failures are safe to
  // compensate immediately; every other outcome requires the on-chain reader.
  const explicitlyTerminal = TERMINAL_SETTLEMENT_REASONS.has(reason);
  if (!explicitlyTerminal) {
    await X402Store.updatePayment(input.payment.id, {
      status: 'reconciliation_required',
      failureReason: `Ambiguous settlement result: ${reason}`,
    }).catch(() => null);
    throw new X402SettlementAmbiguous(reason, result);
  }

  await X402Store.failSettlementOutbox(input.payment.id, reason).catch(() => null);
  await X402Store.updatePayment(input.payment.id, {
      status: 'settlement_failed',
      failureReason: reason,
    });
    await X402Store.addEvent({
      paymentId: input.payment.id,
      sessionId: input.payment.sessionId || undefined,
      eventType: 'x402.payment_failed',
      metadata: { phase: 'settle', reason },
    });
  throw new X402SettlementFailure(reason, result);
}

async function finalizeSettledPayment(
  input: {
    paymentId: string;
    payerWallet?: string;
    transactionHash: string;
    settlementResponse: SettleResponse;
    response: Record<string, unknown>;
  },
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await X402Store.finalizeSettlement({
        ...input,
        settlementResponse: input.settlementResponse as unknown as Record<string, unknown>,
      });
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  console.error(JSON.stringify({
    level: 'critical',
    event: 'x402.settlement_ledger_finalize_failed',
    paymentId: input.paymentId,
    transactionHash: input.transactionHash,
    error: (lastError as Error)?.message || String(lastError),
  }));
  return false;
}

async function compensateCreatedSession(input: {
  deps: X402Dependencies;
  region: RegionConfig;
  payment: X402PaymentRow;
  sessionId: string;
  reason: string;
}): Promise<boolean> {
  try {
    const deletion = await deleteRegionalSession(input.region, input.sessionId, input.deps.serviceAuthToken);
    if (!deletion.response.ok && deletion.response.status !== 404) {
      throw new Error(`Pool manager returned ${deletion.response.status}`);
    }
    const ended = await SessionService.endSession(input.sessionId, 'deleted').catch(() => false);
    if (!ended) {
      const [remaining] = await SessionService.getSession(input.sessionId).catch(() => []);
      if (remaining?.status === 'active') throw new Error('Regional cleanup succeeded but local session repair failed');
    }
    return true;
  } catch (error) {
    await X402Store.updatePayment(input.payment.id, {
      status: 'cleanup_required',
      failureReason: `${input.reason}: ${(error as Error).message}`,
    });
    await X402Store.enqueueCleanup({
      paymentId: input.payment.id,
      sessionId: input.sessionId,
      region: input.region.name,
      reason: input.reason,
      lastError: (error as Error).message,
    });
    await X402Store.addEvent({
      paymentId: input.payment.id,
      sessionId: input.sessionId,
      eventType: 'x402.cleanup_failed',
      metadata: { reason: input.reason, error: (error as Error).message },
    });
    return false;
  }
}

function settlementFailureResult(deps: X402Dependencies, offer: X402Offer, result?: SettleResponse): X402HttpResult {
  return {
    status: 402,
    ...(result ? { headers: {
      'PAYMENT-REQUIRED': offer.header,
      'PAYMENT-RESPONSE': deps.gateway.settlementHeader(result),
    } } : { headers: { 'PAYMENT-REQUIRED': offer.header } }),
    body: { error: 'Payment settlement failed; the session change was rolled back' },
  };
}

function settlementAmbiguousResult(deps: X402Dependencies, offer: X402Offer, result?: SettleResponse): X402HttpResult {
  return {
    status: 503,
    headers: {
      'Retry-After': '5',
      'PAYMENT-REQUIRED': offer.header,
      ...(result ? { 'PAYMENT-RESPONSE': deps.gateway.settlementHeader(result) } : {}),
    },
    body: { error: 'Payment settlement outcome is pending reconciliation; no success response has been issued' },
  };
}

async function withX402Claims(
  idempotencyKey: string,
  sessionId: string | undefined,
  callback: (guard: X402LeaseGuard) => Promise<X402HttpResult>,
): Promise<X402HttpResult> {
  try {
    return await X402Store.withLocks(idempotencyKey, sessionId, callback);
  } catch (error) {
    if (error instanceof X402ClaimBusyError) {
      return {
        status: 409,
        headers: { 'Retry-After': '1' },
        body: { error: 'Another request is already operating on this x402 resource; retry shortly' },
      };
    }
    throw error;
  }
}

export class X402SessionController {
  private readonly chainReader: AuthorizationChainReader;

  constructor(private readonly deps: X402Dependencies) {
    this.chainReader = deps.chainReader || createAuthorizationChainReader(deps.config.rpcUrl!);
  }

  private availability(): RegionConfig | X402HttpResult {
    if (!this.deps.config.enabled) return { status: 404, body: { error: 'x402 sessions are not enabled' } };
    const region = findDedicatedRegion(this.deps.config, this.deps.regions);
    if (!region) return { status: 503, body: { error: 'The dedicated x402 region is unavailable' } };
    return region;
  }

  private async applySettledExtension(
    row: { sessionId: string; recovery: unknown },
    response: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const recovery = readExtensionRecovery(row.recovery);
    const region = recovery && this.deps.regions.find((candidate) => candidate.name === recovery.region);
    let expiresAt = typeof response.expiresAt === 'string' ? response.expiresAt : '';
    const additionalMinutes = Number(response.additionalMinutes);
    const paidMinutesTotal = Number(response.paidMinutesTotal);
    const paidBlocks = paidMinutesTotal / 5;
    if (!recovery || !region || !Number.isFinite(Date.parse(expiresAt))
      || !Number.isInteger(paidBlocks) || paidBlocks <= recovery.previousPaidBlocks
      || !Number.isInteger(additionalMinutes) || additionalMinutes <= 0) {
      throw new Error('Invalid settled extension access state');
    }

    let remote: Awaited<ReturnType<typeof extendRegionalSessionTtl>>;
    const requiresReallocation = Date.parse(recovery.previousExpiresAt) <= Date.now();
    if (requiresReallocation) {
      // A long ambiguous-settlement outage may outlive the old GameServer. Once
      // payment is positively proven, recreate the expired workload under the
      // same session ID/token and grant the full purchased duration from now.
      expiresAt = new Date(Date.now() + additionalMinutes * 60_000).toISOString();
      remote = await reallocateExpiredRegionalSession(
        region,
        row.sessionId,
        expiresAt,
        this.deps.serviceAuthToken,
      );
    } else {
      remote = await extendRegionalSessionTtl(
        region,
        row.sessionId,
        expiresAt,
        this.deps.serviceAuthToken,
      );
    }
    if (requiresReallocation && remote.response.ok
      && typeof remote.body?.expiresAt === 'string'
      && Date.parse(remote.body.expiresAt) > Date.now()) {
      expiresAt = new Date(remote.body.expiresAt).toISOString();
    }
    if (!remote.response.ok || remote.body?.expiresAt !== expiresAt) {
      throw new Error(`Regional settled extension/reallocation failed: ${remote.response.status}`);
    }
    const confirmed = await getRegionalSession(region, row.sessionId, this.deps.serviceAuthToken);
    if (!confirmed.response.ok || confirmed.body?.expiresAt !== expiresAt) {
      throw new Error(`Regional settled extension confirmation failed: ${confirmed.response.status}`);
    }
    const stableEndpoints = publicX402Endpoints(remote.body, region.publicGatewayUrl, row.sessionId);
    if (!stableEndpoints.connectUrl || !stableEndpoints.liveViewUrl
      || stableEndpoints.connectUrl !== recovery.previousEndpoints.connectUrl
      || stableEndpoints.liveViewUrl !== recovery.previousEndpoints.liveViewUrl) {
      throw new Error('Regional settled extension did not preserve the original URLs');
    }

    await SessionService.reactivateSession(row.sessionId, {
      ...recovery.previousMetadata,
      expiresAt,
      restrictedTokenExpiresAt: expiresAt,
      browserPodId: remote.body?.browserPodId,
      x402PublicEndpoints: stableEndpoints,
    });
    await X402Store.updateSessionAccess(row.sessionId, {
      paidBlocks,
      expiresAt: new Date(expiresAt),
    });
    const activated = await activateRegionalSessionAccess(
      region,
      row.sessionId,
      expiresAt,
      this.deps.serviceAuthToken,
    );
    if (!activated.response.ok || activated.body?.expiresAt !== expiresAt) {
      throw new Error(`Regional paid access activation failed: ${activated.response.status}`);
    }
    return { ...response, expiresAt };
  }

  private async rollbackUnsettledExtension(
    row: Awaited<ReturnType<typeof X402Store.listPendingOperationIntents>>[number],
    payment: X402PaymentRow,
    reason: string,
  ): Promise<boolean> {
    const recovery = readExtensionRecovery(row.recovery);
    const region = recovery && this.deps.regions.find((candidate) => candidate.name === recovery.region);
    if (!recovery || !region) {
      await X402Store.markSettlementReconciliationAttempt(payment.id, 'Invalid extension recovery state');
      return false;
    }
    const restored = await recoverInterruptedExtension({
      rollbackRegional: async () => {
        const result = await extendRegionalSessionTtl(
          region,
          row.sessionId,
          recovery.previousExpiresAt,
          this.deps.serviceAuthToken,
        );
        return result.response.ok || result.response.status === 404;
      },
      rollbackMetadata: async () => {
        await SessionService.updateSessionMetadata(row.sessionId, recovery.previousMetadata);
        return true;
      },
      rollbackAccess: async () => {
        await X402Store.updateSessionAccess(row.sessionId, {
          paidBlocks: recovery.previousPaidBlocks,
          expiresAt: new Date(recovery.previousExpiresAt),
        });
        return true;
      },
    });
    if (!restored) {
      await X402Store.updatePayment(payment.id, {
        status: 'extension_recovery_required',
        failureReason: reason,
      }).catch(() => null);
      await X402Store.markSettlementReconciliationAttempt(payment.id, `${reason}; rollback will retry`);
      return false;
    }
    await X402Store.failSettlementOutbox(payment.id, reason);
    await X402Store.updatePayment(payment.id, { status: 'extension_failed', failureReason: reason });
    await X402Store.addEvent({
      paymentId: payment.id,
      sessionId: row.sessionId,
      eventType: 'x402.extension_rolled_back',
      metadata: { reason, previousExpiresAt: recovery.previousExpiresAt },
    }).catch(() => null);
    return true;
  }

  async reconcilePendingSettlements(): Promise<void> {
    const cleanups = await X402Store.listPendingCleanups(10);
    for (const cleanup of cleanups) {
      const region = this.deps.regions.find((candidate) => candidate.name === cleanup.region);
      if (!region) {
        await X402Store.markCleanupAttempt(cleanup.id, `Unknown cleanup region: ${cleanup.region}`);
        continue;
      }
      try {
        await X402Store.withLocks(`cleanup:${cleanup.id}`, cleanup.sessionId, async (lease) => {
          await lease.assertOwned();
          const completed = await runCleanupAttempt({
            deleteRegional: async () => {
              const result = await deleteRegionalSession(region, cleanup.sessionId, this.deps.serviceAuthToken);
              return result.response.ok || result.response.status === 404;
            },
            endLocal: async () => {
              const changed = await SessionService.endSession(cleanup.sessionId, 'deleted');
              if (changed) return true;
              const [session] = await SessionService.getSession(cleanup.sessionId);
              return !session || session.status !== 'active';
            },
          });
          if (!completed) {
            await X402Store.markCleanupAttempt(cleanup.id, 'Cleanup target is still active');
            return;
          }
          await X402Store.completeCleanup(cleanup.id);
          await X402Store.addEvent({
            paymentId: cleanup.paymentId,
            sessionId: cleanup.sessionId,
            eventType: 'x402.cleanup_completed',
            metadata: { reason: cleanup.reason, attempts: cleanup.attempts + 1 },
          }).catch(() => null);
        });
      } catch (error) {
        if (!(error instanceof X402ClaimBusyError)) {
          await X402Store.markCleanupAttempt(cleanup.id, (error as Error).message).catch(() => null);
        }
      }
    }
    const intents = await X402Store.listPendingOperationIntents(10);
    for (const row of intents) {
      const payment = await X402Store.getPayment(row.paymentId);
      if (!payment) continue;
      try {
        await X402Store.withLocks(payment.idempotencyKey, row.sessionId, async (lease) => {
          await lease.assertOwned();
          if (row.operation === 'extend') {
            await this.rollbackUnsettledExtension(row, payment, 'Extension interrupted before settlement was armed');
            return;
          }
          const regionName = row.recovery && typeof row.recovery === 'object' && !Array.isArray(row.recovery)
            ? (row.recovery as Record<string, unknown>).region : undefined;
          const region = this.deps.regions.find((candidate) => candidate.name === regionName);
          if (!region) throw new Error('Invalid create recovery region');
          const deleted = await runCleanupAttempt({
            deleteRegional: async () => {
              const result = await deleteRegionalSession(region, row.sessionId, this.deps.serviceAuthToken);
              return result.response.ok || result.response.status === 404;
            },
            endLocal: async () => {
              const changed = await SessionService.endSession(row.sessionId, 'deleted');
              if (changed) return true;
              const [session] = await SessionService.getSession(row.sessionId);
              return !session || session.status !== 'active';
            },
          });
          if (!deleted) {
            await X402Store.enqueueCleanup({
              paymentId: payment.id,
              sessionId: row.sessionId,
              region: region.name,
              reason: 'interrupted_create_intent',
            });
          }
          await X402Store.failSettlementOutbox(payment.id, 'Create interrupted before settlement was armed');
          await X402Store.updatePayment(payment.id, {
            status: deleted ? 'allocation_failed' : 'cleanup_required',
            failureReason: 'Create interrupted before settlement was armed',
          });
        });
      } catch (error) {
        if (!(error instanceof X402ClaimBusyError)) {
          await X402Store.markSettlementReconciliationAttempt(row.paymentId, (error as Error).message).catch(() => null);
        }
      }
    }
    const rows = await X402Store.listPendingSettlements(10);
    for (const row of rows) {
      const payment = await X402Store.getPayment(row.paymentId);
      if (!payment || payment.status === 'settled') continue;
      try {
        await X402Store.withLocks(payment.idempotencyKey, row.sessionId, async (lease) => {
          await lease.assertOwned();
          const request = decryptX402SettlementRequest<{
            payload: PaymentPayload;
            requirements: PaymentRequirements;
            extensions?: Record<string, unknown>;
          }>(this.deps.config.serverSecret!, row.settlementRequestEncrypted);
          const chainOutcome = await inspectAuthorizationOutcome(
            request.payload,
            request.requirements,
            row.settlementStartBlock,
            this.chainReader,
          );
          if (chainOutcome.status === 'unknown') {
            // Unknown includes RPC outages and consumed authorizations whose
            // transaction evidence is not currently discoverable. It is never
            // proof that payment was unused, even after validBefore.
            await X402Store.markSettlementReconciliationAttempt(row.paymentId, chainOutcome.reason);
            return;
          }
          let result: SettleResponse;
          if (chainOutcome.status === 'settled') {
            result = {
              success: true,
              transaction: chainOutcome.transactionHash,
              network: request.requirements.network,
              payer: chainOutcome.payer,
            };
          } else {
            const nowSeconds = Math.floor(Date.now() / 1000);
            if (chainOutcome.validBefore !== undefined && chainOutcome.validBefore <= nowSeconds + 15) {
              if (row.operation === 'extend') {
                await this.rollbackUnsettledExtension(row, payment, 'Authorization expired without on-chain use');
                return;
              }
              const region = findDedicatedRegion(this.deps.config, this.deps.regions);
              if (region) {
                await compensateCreatedSession({
                  deps: this.deps,
                  region,
                  payment,
                  sessionId: row.sessionId,
                  reason: 'unspent_authorization_expired',
                });
              }
              await X402Store.failSettlementOutbox(row.paymentId, 'Authorization expired without on-chain use').catch(() => null);
              await X402Store.updatePayment(row.paymentId, {
                status: 'settlement_failed',
                failureReason: 'Authorization expired without on-chain use',
              }).catch(() => null);
              return;
            }
            try {
              result = await this.deps.gateway.settleRaw(
                request.payload,
                request.requirements,
                request.extensions,
              );
          } catch (error) {
            await X402Store.markSettlementReconciliationAttempt(row.paymentId, (error as Error).message);
            return;
            }
            if (!result.success) {
              await X402Store.markSettlementReconciliationAttempt(
                row.paymentId,
                result.errorReason || result.errorMessage || 'Facilitator could not reconcile settlement',
              );
              return;
            }
          }
          const draft = row.response as Record<string, unknown>;
          const paymentSummary = draft.payment && typeof draft.payment === 'object'
            ? draft.payment as Record<string, unknown> : {};
          const response = {
            ...draft,
            payment: { ...paymentSummary, transaction: result.transaction },
          };
          let finalizedResponse: Record<string, unknown> = response;
          if (row.operation === 'extend') {
            finalizedResponse = await this.applySettledExtension(row, response);
          }
          await X402Store.finalizeSettlement({
            paymentId: row.paymentId,
            payerWallet: result.payer || payment.payerWallet || undefined,
            transactionHash: result.transaction,
            settlementResponse: result as unknown as Record<string, unknown>,
            response: finalizedResponse,
          });
          await X402Store.addEvent({
            paymentId: row.paymentId,
            sessionId: row.sessionId,
            eventType: 'x402.settlement_reconciled',
            metadata: { transaction: result.transaction, operation: row.operation },
          }).catch(() => null);
        });
      } catch (error) {
        if (!(error instanceof X402ClaimBusyError)) {
          await X402Store.markSettlementReconciliationAttempt(row.paymentId, (error as Error).message).catch(() => null);
        }
      }
    }
  }

  async create(input: X402RequestInput, body: unknown): Promise<X402HttpResult> {
    const available = this.availability();
    if (!('name' in available)) return available;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const keys = Object.keys(body as Record<string, unknown>);
      if (keys.length) return { status: 400, body: { error: 'This endpoint does not accept session IDs, regions, or TTL options' } };
    }
    const key = readIdempotencyKey(input.idempotencyKey);
    if (!key.value) return { status: 400, body: { error: key.error! } };
    const hash = requestHash({ operation: 'create', blocks: 1, region: available.name, network: this.deps.config.network });

    return await withX402Claims(key.value, undefined, async (lease) => {
      const prepared = await reserveAndOffer({
        deps: this.deps,
        operation: 'create',
        blocks: 1,
        idempotencyKey: key.value!,
        requestHash: hash,
        resourceUrl: input.resourceUrl,
        paymentSignature: input.paymentSignature,
      });
      if (!('payment' in prepared)) return prepared;
      const verified = await verifyAndReservePayload({ ...prepared, deps: this.deps, signature: input.paymentSignature });
      if (!('payload' in verified)) return verified;

      let settlementStartBlock: bigint;
      try {
        settlementStartBlock = await this.chainReader.currentBlock();
      } catch (error) {
        await X402Store.updatePayment(prepared.payment.id, {
          status: 'verification_failed',
          failureReason: `Base RPC unavailable before allocation: ${(error as Error).message}`,
        });
        return { status: 503, body: { error: 'Payment reconciliation is unavailable; no session was allocated' } };
      }

      const sessionId = `x402_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + this.deps.config.blockSeconds * 1000);
      try {
        await X402Store.prepareCreateIntent({
          paymentId: prepared.payment.id,
          sessionId,
          response: {
            sessionId,
            paidMinutes: 0,
            expiresAt: createdAt.toISOString(),
            region: available.name,
            clusterName: available.clusterName,
          },
          settlementRequestEncrypted: encryptX402SettlementRequest(
            this.deps.config.serverSecret!,
            {
              payload: verified.payload,
              requirements: verified.requirements,
              extensions: prepared.offer.paymentRequired.extensions,
            },
          ),
          settlementStartBlock,
          recovery: { region: available.name, expectedExpiresAt: expiresAt.toISOString() },
        });
      } catch {
        return { status: 500, body: { error: 'Session allocation intent could not be recorded durably' } };
      }
      await lease.assertOwned();
      const allocation = await allocateInRegion(available, {
        sessionId,
        clientId: PUBLIC_X402_CLIENT_ID,
        clientName: PUBLIC_X402_CLIENT_NAME,
        expiresAt: expiresAt.toISOString(),
        restrictedTokenExpiresAt: expiresAt.toISOString(),
        automationProfile: 'x402-agent',
      }, this.deps.serviceAuthToken);
      if (!allocation.session) {
        await X402Store.updatePayment(prepared.payment.id, {
          status: 'allocation_failed',
          failureReason: allocation.attempt.error || 'Dedicated x402 region had no capacity',
        });
        await X402Store.addEvent({
          paymentId: prepared.payment.id,
          eventType: 'x402.allocation_failed',
          metadata: { region: available.name, error: allocation.attempt.error },
        });
        return { status: 503, body: { error: 'The dedicated x402 cluster has no available capacity' } };
      }

      const endpoints = publicX402Endpoints(allocation.session, available.publicGatewayUrl, sessionId);
      if (!endpoints.connectUrl || !endpoints.liveViewUrl) {
        await X402Store.updatePayment(prepared.payment.id, {
          status: 'allocation_failed',
          failureReason: 'Pool manager returned invalid public gateway URLs',
        });
        await compensateCreatedSession({
          deps: this.deps,
          region: available,
          payment: prepared.payment,
          sessionId,
          reason: 'invalid_public_urls',
        });
        return { status: 502, body: { error: 'The dedicated x402 cluster returned invalid public URLs' } };
      }
      const capability = deriveSessionCapability(this.deps.config.serverSecret!, sessionId);
      try {
        await SessionService.createSession(
          sessionId,
          PUBLIC_X402_CLIENT_ID,
          PUBLIC_X402_CLIENT_NAME,
          available.clusterName,
          available.name,
          {
            expiresAt: expiresAt.toISOString(),
            restrictedTokenExpiresAt: expiresAt.toISOString(),
            browserPodId: allocation.session.browserPodId,
            x402PublicEndpoints: endpoints,
            billing: { type: 'x402', paidBlocks: 1, amountAtomic: prepared.payment.amountAtomic },
          },
        );
        await X402Store.createSessionAccess({
          sessionId,
          capabilityHash: sha256(capability),
          paidBlocks: 1,
          expiresAt,
        });
        await X402Store.updatePayment(prepared.payment.id, { sessionId, status: 'allocated' });
      } catch (error) {
        await compensateCreatedSession({
          deps: this.deps,
          region: available,
          payment: prepared.payment,
          sessionId,
          reason: 'local_record_failed',
        });
        return { status: 500, body: { error: 'Session allocation could not be recorded safely' } };
      }

      const responseDraft = {
        sessionId,
        ...endpoints,
        paidMinutes: 5,
        expiresAt: expiresAt.toISOString(),
        region: available.name,
        clusterName: available.clusterName,
        payment: {
          amountAtomic: prepared.payment.amountAtomic,
          currency: 'USDC',
          network: this.deps.config.network,
        },
      };
      try {
        await X402Store.armOperationSettlement(prepared.payment.id, responseDraft);
      } catch (error) {
        await compensateCreatedSession({
          deps: this.deps,
          region: available,
          payment: prepared.payment,
          sessionId,
          reason: 'settlement_outbox_prepare_failed',
        });
        return { status: 500, body: { error: 'Payment settlement could not be prepared durably' } };
      }
      try {
        await lease.assertOwned();
      } catch {
        await compensateCreatedSession({
          deps: this.deps,
          region: available,
          payment: prepared.payment,
          sessionId,
          reason: 'operation_lease_lost_before_settlement',
        });
        return { status: 409, body: { error: 'Operation ownership changed before settlement; payment was not settled' } };
      }

      let settlement: SettleResponse;
      try {
        settlement = await settle({ deps: this.deps, payment: prepared.payment, offer: prepared.offer, verified });
      } catch (error) {
        if (error instanceof X402SettlementAmbiguous) {
          return settlementAmbiguousResult(this.deps, prepared.offer, error.result);
        }
        await compensateCreatedSession({
          deps: this.deps,
          region: available,
          payment: prepared.payment,
          sessionId,
          reason: 'settlement_failed',
        });
        return settlementFailureResult(
          this.deps,
          prepared.offer,
          error instanceof X402SettlementFailure ? error.result : undefined,
        );
      }

      const response = {
        ...responseDraft,
        payment: {
          ...responseDraft.payment,
          transaction: settlement.transaction,
        },
      };
      try {
        await lease.assertOwned();
      } catch {
        return {
          status: 503,
          headers: { 'Retry-After': '5', 'PAYMENT-RESPONSE': this.deps.gateway.settlementHeader(settlement) },
          body: { error: 'Payment settled but operation ownership changed; durable reconciliation will complete the response' },
        };
      }
      const finalized = await finalizeSettledPayment({
        paymentId: prepared.payment.id,
        payerWallet: settlement.payer || verified.payer,
        transactionHash: settlement.transaction,
        settlementResponse: settlement,
        response,
      });
      if (!finalized) {
        return {
          status: 503,
          headers: {
            'Retry-After': '5',
            'PAYMENT-RESPONSE': this.deps.gateway.settlementHeader(settlement),
          },
          body: { error: 'Payment settled but the durable response is awaiting reconciliation' },
        };
      }
      await X402Store.addEvent({
        paymentId: prepared.payment.id,
        sessionId,
        eventType: 'x402.session_created',
        metadata: { amountAtomic: prepared.payment.amountAtomic, paidMinutes: 5, region: available.name },
      }).catch((error) => console.error('Failed to record x402 session-created analytics:', error));
      return {
        status: 200,
        headers: { 'PAYMENT-RESPONSE': this.deps.gateway.settlementHeader(settlement) },
        body: publicSessionResponse(response, this.deps.config, sessionId),
      };
    });
  }

  private async ownedSession(capability: string): Promise<{
    region: RegionConfig;
    session: Awaited<ReturnType<typeof SessionService.getSession>>[number];
    access: X402SessionRow;
  } | X402HttpResult> {
    const available = this.availability();
    if (!('name' in available)) return available;
    const access = await X402Store.getSessionAccessByCapabilityHash(sha256(capability));
    if (!access) return { status: 404, body: { error: 'Session not found' } };
    const [session] = await SessionService.getSession(access.sessionId);
    if (!isOwnedPublicX402Session(session, access, {
      clientId: PUBLIC_X402_CLIENT_ID,
      region: available.name,
      clusterName: available.clusterName,
    })) {
      return { status: 404, body: { error: 'Session not found' } };
    }
    return { region: available, session, access };
  }

  async status(capability: string): Promise<X402HttpResult> {
    const owned = await this.ownedSession(capability);
    if (!('access' in owned)) return owned;
    const sessionId = owned.session.sessionId;
    const unresolvedExtension = await X402Store.getUnresolvedExtensionForSession(sessionId);
    const recovery = readExtensionRecovery(unresolvedExtension?.recovery);
    const visibleExpiresAt = recovery ? new Date(recovery.previousExpiresAt) : owned.access.expiresAt;
    const visiblePaidBlocks = recovery?.previousPaidBlocks || owned.access.paidBlocks;
    const active = owned.session.status === 'active' && visibleExpiresAt.getTime() > Date.now();
    // Never expose unpaid TTL while an extension is unresolved. The stable
    // endpoints remain authorized only through the previous paid deadline.
    let endpoints = recovery?.previousEndpoints
      || endpointMetadata(owned.session, owned.region.publicGatewayUrl, sessionId);
    if (active && (!endpoints.connectUrl || !endpoints.liveViewUrl)) {
      // A remote lookup is safe only when no payment transition is pending.
      if (!recovery) {
        const remote = await getRegionalSession(owned.region, sessionId, this.deps.serviceAuthToken).catch(() => null);
        if (remote?.response.ok && remote.body) endpoints = publicX402Endpoints(remote.body, owned.region.publicGatewayUrl, sessionId);
      }
    }
    return {
      status: 200,
      body: publicSessionResponse({
        sessionId,
        status: active ? 'active' : owned.session.status === 'active' ? 'expired' : owned.session.status,
        paidMinutes: visiblePaidBlocks * 5,
        expiresAt: visibleExpiresAt.toISOString(),
        region: owned.region.name,
        clusterName: owned.region.clusterName,
        ...(active ? endpoints : {}),
      }, this.deps.config, sessionId),
    };
  }

  async extend(capability: string, input: X402RequestInput, body: unknown): Promise<X402HttpResult> {
    const owned = await this.ownedSession(capability);
    if (!('access' in owned)) return owned;
    const sessionId = owned.session.sessionId;
    const blocks = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).blocks
      : undefined;
    if (!Number.isInteger(blocks) || (blocks as number) <= 0 || (blocks as number) > this.deps.config.maxExtensionBlocks) {
      return { status: 400, body: { error: `blocks must be an integer from 1 to ${this.deps.config.maxExtensionBlocks}` } };
    }
    const key = readIdempotencyKey(input.idempotencyKey);
    if (!key.value) return { status: 400, body: { error: key.error! } };
    const hash = requestHash({ operation: 'extend', sessionId, blocks, network: this.deps.config.network });

    return await withX402Claims(key.value, sessionId, async (lease) => {
      const [lockedSession] = await SessionService.getSession(sessionId);
      const lockedAccess = await X402Store.getSessionAccess(sessionId);
      const unresolved = await X402Store.getUnresolvedPaymentForSession(sessionId);
      const unresolvedExtension = await X402Store.getUnresolvedExtensionForSession(sessionId);
      const existingPayment = await X402Store.getPaymentByIdempotencyKey(key.value!);
      if (existingPayment) {
        if (existingPayment.requestHash !== hash) {
          return { status: 409, body: { error: 'Idempotency-Key was already used for a different request' } };
        }
        const replay = replaySettled(existingPayment, this.deps.config);
        if (replay) return replay;
        if (['operation_pending', 'settlement_pending', 'reconciliation_required', 'extension_recovery_required']
          .includes(existingPayment.status)) {
          return {
            status: 503,
            headers: { 'Retry-After': '5' },
            body: { error: 'Payment settlement is awaiting durable reconciliation; retry shortly' },
          };
        }
      }
      if (unresolved && unresolved.id !== existingPayment?.id) {
        return {
          status: 409,
          headers: { 'Retry-After': '5' },
          body: { error: 'This session has a payment awaiting settlement reconciliation' },
        };
      }
      if (unresolvedExtension && unresolvedExtension.paymentId !== existingPayment?.id) {
        return {
          status: 409,
          headers: { 'Retry-After': '5' },
          body: { error: 'This session has an extension awaiting rollback or settlement' },
        };
      }
      // Mutable validation happens after settled replay, but before reserving a
      // new unpaid row for an already expired/invalid session.
      if (!lockedSession || !lockedAccess || !isOwnedPublicX402Session(lockedSession, lockedAccess, {
        clientId: PUBLIC_X402_CLIENT_ID,
        region: owned.region.name,
        clusterName: owned.region.clusterName,
      })) {
        return { status: 404, body: { error: 'Session not found' } };
      }
      if (lockedSession.status !== 'active' || !hasX402ExtensionActivationWindow(lockedAccess.expiresAt)) {
        return { status: 409, body: { error: 'Sessions must be active with at least four minutes remaining to extend safely' } };
      }
      if (lockedAccess.paidBlocks + (blocks as number) > this.deps.config.maxPaidBlocks) {
        return { status: 400, body: { error: `A session can have at most ${this.deps.config.maxPaidBlocks * 5} paid minutes` } };
      }
      const prepared = await reserveAndOffer({
        deps: this.deps,
        operation: 'extend',
        sessionId,
        blocks: blocks as number,
        idempotencyKey: key.value!,
        requestHash: hash,
        resourceUrl: input.resourceUrl,
        paymentSignature: input.paymentSignature,
      });
      // Settled idempotent replay is returned by reserveAndOffer before these
      // mutable lifecycle/limit checks.
      if (!('payment' in prepared)) return prepared;
      const verified = await verifyAndReservePayload({ ...prepared, deps: this.deps, signature: input.paymentSignature });
      if (!('payload' in verified)) return verified;

      let settlementStartBlock: bigint;
      try {
        settlementStartBlock = await this.chainReader.currentBlock();
      } catch (error) {
        await X402Store.updatePayment(prepared.payment.id, {
          status: 'verification_failed',
          failureReason: `Base RPC unavailable before extension: ${(error as Error).message}`,
        });
        return { status: 503, body: { error: 'Payment reconciliation is unavailable; the session was not extended' } };
      }

      const previousExpiresAt = lockedAccess.expiresAt;
      const newExpiresAt = new Date(previousExpiresAt.getTime()
        + (blocks as number) * this.deps.config.blockSeconds * 1000);
      const previousMetadata = getMetadata(lockedSession);
      const previousEndpoints = endpointMetadata(lockedSession, owned.region.publicGatewayUrl, sessionId);
      const provisionalResponse = {
        sessionId,
        ...previousEndpoints,
        additionalMinutes: (blocks as number) * 5,
        amountPaidAtomic: prepared.payment.amountAtomic,
        paidMinutesTotal: lockedAccess.paidBlocks * 5,
        expiresAt: previousExpiresAt.toISOString(),
        payment: { currency: 'USDC', network: this.deps.config.network },
      };
      const recovery = {
        region: owned.region.name,
        previousExpiresAt: previousExpiresAt.toISOString(),
        previousPaidBlocks: lockedAccess.paidBlocks,
        previousMetadata,
        previousEndpoints,
      };
      try {
        await X402Store.prepareExtensionIntent({
          paymentId: prepared.payment.id,
          sessionId,
          response: provisionalResponse,
          settlementRequestEncrypted: encryptX402SettlementRequest(
            this.deps.config.serverSecret!,
            {
              payload: verified.payload,
              requirements: verified.requirements,
              extensions: prepared.offer.paymentRequired.extensions,
            },
          ),
          settlementStartBlock,
          recovery,
        });
      } catch {
        return { status: 500, body: { error: 'The extension intent could not be recorded durably' } };
      }
      await lease.assertOwned();
      const preflight = await getRegionalSession(owned.region, sessionId, this.deps.serviceAuthToken)
        .catch(() => null);
      const preflightEndpoints = preflight?.response.ok
        ? publicX402Endpoints(preflight.body, owned.region.publicGatewayUrl, sessionId)
        : {};
      if (!preflight?.response.ok || preflight.body?.expiresAt !== previousExpiresAt.toISOString()
        || preflightEndpoints.connectUrl !== previousEndpoints.connectUrl
        || preflightEndpoints.liveViewUrl !== previousEndpoints.liveViewUrl) {
        await X402Store.updatePayment(prepared.payment.id, {
          status: 'extension_failed',
          failureReason: 'Regional session preflight failed before settlement',
        });
        await X402Store.failSettlementOutbox(prepared.payment.id, 'Regional session preflight failed before settlement').catch(() => null);
        return { status: 409, body: { error: 'The regional session is no longer safely extendable; payment was not settled' } };
      }

      const responseDraft = {
        sessionId,
        ...previousEndpoints,
        additionalMinutes: (blocks as number) * 5,
        amountPaidAtomic: prepared.payment.amountAtomic,
        paidMinutesTotal: (lockedAccess.paidBlocks + (blocks as number)) * 5,
        expiresAt: newExpiresAt.toISOString(),
        payment: {
          currency: 'USDC',
          network: this.deps.config.network,
        },
      };
      try {
        await X402Store.armOperationSettlement(prepared.payment.id, responseDraft);
      } catch (error) {
        return { status: 500, body: { error: 'Payment settlement could not be prepared durably' } };
      }
      try {
        await lease.assertOwned();
      } catch {
        return { status: 409, body: { error: 'Operation ownership changed before settlement; payment was not settled' } };
      }

      let settlement: SettleResponse;
      try {
        settlement = await settle({ deps: this.deps, payment: prepared.payment, offer: prepared.offer, verified });
      } catch (error) {
        if (error instanceof X402SettlementAmbiguous) {
          return settlementAmbiguousResult(this.deps, prepared.offer, error.result);
        }
        return settlementFailureResult(
          this.deps,
          prepared.offer,
          error instanceof X402SettlementFailure ? error.result : undefined,
        );
      }

      const response = {
        ...responseDraft,
        payment: {
          ...responseDraft.payment,
          transaction: settlement.transaction,
        },
      };
      try {
        await lease.assertOwned();
      } catch {
        return {
          status: 503,
          headers: { 'Retry-After': '5', 'PAYMENT-RESPONSE': this.deps.gateway.settlementHeader(settlement) },
          body: { error: 'Payment settled but operation ownership changed; durable reconciliation will complete the response' },
        };
      }
      try {
        Object.assign(response, await this.applySettledExtension({ sessionId, recovery }, response));
      } catch (error) {
        await X402Store.updatePayment(prepared.payment.id, {
          status: 'reconciliation_required',
          failureReason: `Payment settled but extension activation is pending: ${(error as Error).message}`,
        }).catch(() => null);
        await X402Store.markSettlementReconciliationAttempt(
          prepared.payment.id,
          `Extension activation failed after settlement: ${(error as Error).message}`,
        ).catch(() => null);
        return {
          status: 503,
          headers: { 'Retry-After': '5', 'PAYMENT-RESPONSE': this.deps.gateway.settlementHeader(settlement) },
          body: { error: 'Payment settled; the existing URL extension will complete through durable reconciliation' },
        };
      }
      const finalized = await finalizeSettledPayment({
        paymentId: prepared.payment.id,
        payerWallet: settlement.payer || verified.payer,
        transactionHash: settlement.transaction,
        settlementResponse: settlement,
        response,
      });
      if (!finalized) {
        return {
          status: 503,
          headers: {
            'Retry-After': '5',
            'PAYMENT-RESPONSE': this.deps.gateway.settlementHeader(settlement),
          },
          body: { error: 'Payment settled but the durable response is awaiting reconciliation' },
        };
      }
      await X402Store.addEvent({
        paymentId: prepared.payment.id,
        sessionId,
        eventType: 'x402.session_extended',
        metadata: { blocks, amountAtomic: prepared.payment.amountAtomic, expiresAt: newExpiresAt.toISOString() },
      }).catch((error) => console.error('Failed to record x402 extension analytics:', error));
      return {
        status: 200,
        headers: { 'PAYMENT-RESPONSE': this.deps.gateway.settlementHeader(settlement) },
        body: publicSessionResponse(response, this.deps.config, sessionId),
      };
    });
  }

  async terminate(capability: string): Promise<X402HttpResult> {
    const owned = await this.ownedSession(capability);
    if (!('access' in owned)) return owned;
    const sessionId = owned.session.sessionId;
    return await withX402Claims(`terminate:${sessionId}`, sessionId, async (lease) => {
      const current = await this.ownedSession(capability);
      if (!('access' in current)) return current;
      if (await X402Store.getUnresolvedPaymentForSession(sessionId)) {
        return {
          status: 409,
          headers: { 'Retry-After': '5' },
          body: { error: 'This session has a payment awaiting settlement reconciliation' },
        };
      }
      if (current.session.status !== 'active' || current.access.expiresAt.getTime() <= Date.now()) {
        return { status: 409, body: { error: 'Session is no longer active' } };
      }
      await lease.assertOwned();
      const deletion = await deleteRegionalSession(current.region, sessionId, this.deps.serviceAuthToken)
        .catch((error) => ({ response: null, body: { error: (error as Error).message } }));
      if (!deletion.response || (!deletion.response.ok && deletion.response.status !== 404)) {
        return { status: 502, body: { error: 'The regional session could not be terminated' } };
      }
      await SessionService.endSession(sessionId, 'deleted');
      await X402Store.addEvent({
        sessionId,
        eventType: 'x402.session_terminated',
        metadata: { refund: false, paidBlocks: current.access.paidBlocks },
      }).catch((error) => console.error('Failed to record x402 terminate analytics:', error));
      return {
        status: 200,
        body: publicSessionResponse({ success: true, sessionId, refund: false }, this.deps.config, sessionId),
      };
    });
  }
}

export function createX402SessionController(deps: X402Dependencies): X402SessionController {
  return new X402SessionController(deps);
}
