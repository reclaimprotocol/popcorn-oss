import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import {
  createPublicClient,
  decodeFunctionData,
  http,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
} from 'viem';

const AUTHORIZATION_USED = parseAbiItem(
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
);
const AUTHORIZATION_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
]);
const AUTHORIZATION_EXECUTION_ABI = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
]);
const SEARCH_CHUNK_BLOCKS = 1_000n;
const MAX_AUTHORIZATION_HORIZON_BLOCKS = 2_000n;

export function authorizationSearchRanges(startBlock: bigint, latestBlock: bigint): Array<{ fromBlock: bigint; toBlock: bigint }> {
  const horizonEnd = startBlock + MAX_AUTHORIZATION_HORIZON_BLOCKS - 1n;
  const endBlock = latestBlock < horizonEnd ? latestBlock : horizonEnd;
  const ranges: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  for (let fromBlock = startBlock; fromBlock <= endBlock; fromBlock += SEARCH_CHUNK_BLOCKS) {
    ranges.push({
      fromBlock,
      toBlock: fromBlock + SEARCH_CHUNK_BLOCKS - 1n < endBlock
        ? fromBlock + SEARCH_CHUNK_BLOCKS - 1n : endBlock,
    });
  }
  return ranges;
}

export type AuthorizationOutcome =
  | { status: 'unused'; validBefore?: number }
  | { status: 'settled'; transactionHash: string; payer: string }
  | { status: 'unknown'; reason: string };

export interface AuthorizationTransactionEvidence {
  hash: Hex;
  to?: Address | null;
  input: Hex;
  receiptStatus: 'success' | 'reverted';
}

export interface AuthorizationChainReader {
  currentBlock(): Promise<bigint>;
  chainId(): Promise<number>;
  authorizationUsed(asset: Address, payer: Address, nonce: Hex): Promise<boolean>;
  authorizationTransaction(
    asset: Address,
    payer: Address,
    nonce: Hex,
    startBlock: bigint,
  ): Promise<AuthorizationTransactionEvidence | undefined>;
}

function normalizeAddress(value: unknown): string | undefined {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? value.toLowerCase() : undefined;
}

function normalizeBytes32(value: unknown): string | undefined {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value) ? value.toLowerCase() : undefined;
}

function toBigInt(value: unknown): bigint | undefined {
  try {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
      ? BigInt(value) : undefined;
  } catch {
    return undefined;
  }
}

function expectedChainId(network: string): number | undefined {
  if (network === 'eip155:8453') return 8453;
  if (network === 'eip155:84532') return 84532;
  return undefined;
}

export async function inspectAuthorizationOutcome(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  startBlock: bigint,
  reader: AuthorizationChainReader,
): Promise<AuthorizationOutcome> {
  const auth = payload.payload?.authorization as Record<string, unknown> | undefined;
  const payer = normalizeAddress(auth?.from);
  const recipient = normalizeAddress(auth?.to);
  const nonce = normalizeBytes32(auth?.nonce);
  const value = toBigInt(auth?.value);
  const validAfter = toBigInt(auth?.validAfter);
  const validBefore = toBigInt(auth?.validBefore);
  const asset = normalizeAddress(requirements.asset);
  const payTo = normalizeAddress(requirements.payTo);
  const amount = toBigInt(requirements.amount);
  const networkChainId = expectedChainId(requirements.network);
  if (!payer || !recipient || !nonce || value === undefined || validAfter === undefined
    || validBefore === undefined || !asset || !payTo || amount === undefined || !networkChainId) {
    return { status: 'unknown', reason: 'Invalid EIP-3009 settlement evidence inputs' };
  }
  if (recipient !== payTo || value !== amount) {
    return { status: 'unknown', reason: 'Signed authorization does not match payment requirements' };
  }

  try {
    if (await reader.chainId() !== networkChainId) {
      return { status: 'unknown', reason: 'Base RPC chain does not match the payment network' };
    }
    const used = await reader.authorizationUsed(asset as Address, payer as Address, nonce as Hex);
    if (!used) return { status: 'unused', validBefore: Number(validBefore) };
    const evidence = await reader.authorizationTransaction(
      asset as Address,
      payer as Address,
      nonce as Hex,
      startBlock,
    );
    if (!evidence) return { status: 'unknown', reason: 'Authorization is used but its transaction was not found' };
    if (evidence.receiptStatus !== 'success' || normalizeAddress(evidence.to) !== asset) {
      return { status: 'unknown', reason: 'Authorization transaction did not successfully call the expected asset' };
    }
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: AUTHORIZATION_EXECUTION_ABI, data: evidence.input });
    } catch {
      return { status: 'unknown', reason: 'Authorization transaction calldata could not be decoded' };
    }
    const args = decoded.args;
    if (!args || (decoded.functionName !== 'transferWithAuthorization'
      && decoded.functionName !== 'receiveWithAuthorization')) {
      return { status: 'unknown', reason: 'Transaction did not execute an EIP-3009 authorization' };
    }
    const matches = normalizeAddress(args[0]) === payer
      && normalizeAddress(args[1]) === recipient
      && toBigInt(args[2]) === value
      && toBigInt(args[3]) === validAfter
      && toBigInt(args[4]) === validBefore
      && normalizeBytes32(args[5]) === nonce;
    return matches
      ? { status: 'settled', transactionHash: evidence.hash, payer }
      : { status: 'unknown', reason: 'On-chain authorization does not match the signed Popcorn payment' };
  } catch (error) {
    return { status: 'unknown', reason: `Base RPC lookup failed: ${(error as Error).message}` };
  }
}

export function createAuthorizationChainReader(rpcUrl: string): AuthorizationChainReader {
  const client = createPublicClient({ transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) });
  return {
    currentBlock: async () => await client.getBlockNumber(),
    chainId: async () => await client.getChainId(),
    authorizationUsed: async (asset, payer, nonce) => await client.readContract({
      address: asset,
      abi: AUTHORIZATION_STATE_ABI,
      functionName: 'authorizationState',
      args: [payer, nonce],
    }),
    authorizationTransaction: async (asset, payer, nonce, startBlock) => {
      const latest = await client.getBlockNumber();
      for (const { fromBlock, toBlock } of authorizationSearchRanges(startBlock, latest)) {
        const logs = await client.getLogs({
          address: asset,
          event: AUTHORIZATION_USED,
          args: { authorizer: payer, nonce },
          fromBlock,
          toBlock,
        });
        const log = logs.at(-1);
        if (!log?.transactionHash) continue;
        const [transaction, receipt] = await Promise.all([
          client.getTransaction({ hash: log.transactionHash }),
          client.getTransactionReceipt({ hash: log.transactionHash }),
        ]);
        return {
          hash: log.transactionHash,
          to: transaction.to,
          input: transaction.input,
          receiptStatus: receipt.status,
        };
      }
      return undefined;
    },
  };
}
