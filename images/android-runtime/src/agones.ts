/**
 * Agones SDK over its local HTTP sidecar.
 *
 * Agones injects an `agones-sdk` container into every GameServer pod and
 * expects the game server - here, the emulator runtime - to say when it is
 * ready and to keep saying it is alive. A pod that never calls `ready` is never
 * allocated; one that stops calling `health` is replaced. The HTTP interface is
 * used in preference to gRPC so the runtime carries no extra dependency.
 */
export class Agones {
  private readonly base: string;
  private timer?: NodeJS.Timeout;

  constructor(port = process.env.AGONES_SDK_HTTP_PORT ?? "9358") {
    this.base = `http://127.0.0.1:${port}`;
  }

  /** True when the sidecar answers, false when running outside Kubernetes. */
  async available(): Promise<boolean> {
    try {
      const response = await fetch(`${this.base}/gameserver`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async ready(): Promise<void> {
    await this.post("/ready");
  }

  async shutdown(): Promise<void> {
    await this.post("/shutdown");
  }

  /** Agones marks the pod unhealthy if these stop; the interval must stay
   *  comfortably under the Fleet's `health.periodSeconds`. */
  startHealthLoop(intervalMs = 2000): void {
    this.timer = setInterval(() => void this.post("/health"), intervalMs);
    this.timer.unref?.();
  }

  stopHealthLoop(): void {
    clearInterval(this.timer);
  }

  private async post(path: string): Promise<void> {
    try {
      await fetch(`${this.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // Outside Kubernetes there is no sidecar, and that is not an error here.
    }
  }
}
