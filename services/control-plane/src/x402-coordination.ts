import crypto from 'node:crypto';

export class X402ClaimBusyError extends Error {
  constructor() {
    super('Another request is already operating on this x402 resource');
  }
}

export interface X402LeaseClaimAdapter {
  acquire(claimKey: string, owner: string): Promise<boolean>;
  renew(claimKey: string, owner: string): Promise<boolean>;
  release(claimKey: string, owner: string): Promise<void>;
}

export interface X402LeaseGuard {
  assertOwned(): Promise<void>;
  retain(): void;
}

export async function withLeaseClaims<T>(
  claimKeys: string[],
  adapter: X402LeaseClaimAdapter,
  callback: (guard: X402LeaseGuard) => Promise<T>,
  owner: string = crypto.randomUUID(),
): Promise<T> {
  const acquired: string[] = [];
  let retained = false;
  let lost = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    for (const claimKey of [...new Set(claimKeys)].sort()) {
      if (!await adapter.acquire(claimKey, owner)) throw new X402ClaimBusyError();
      acquired.push(claimKey);
    }
    const renew = async () => {
      for (const claimKey of acquired) {
        if (!await adapter.renew(claimKey, owner)) {
          lost = true;
          throw new X402ClaimBusyError();
        }
      }
    };
    heartbeat = setInterval(() => {
      void renew().catch(() => undefined);
    }, 30_000);
    heartbeat.unref?.();
    return await callback({
      assertOwned: async () => {
        if (lost) throw new X402ClaimBusyError();
        await renew();
      },
      retain: () => { retained = true; },
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (!retained) for (const claimKey of acquired.reverse()) {
      await adapter.release(claimKey, owner).catch((error) => {
        console.error('Failed to release x402 operation claim:', error);
      });
    }
  }
}
