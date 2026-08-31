// runtime-busy.mjs — refuse to drive a browser runtime another run is already using.
//
// One container, one X screen, every viewer sharing it. A second run resizes that
// screen to ITS device's geometry, so two harnesses flap it between (say) 402x714
// and 412x783 several times a second: each side's candidate is recorded at the
// other's resolution, markers land in the wrong place, and cases fail for reasons
// that read exactly like product defects. Xvnc has aborted outright under the churn.
// None of it is visible in the failing run's own artifacts, which is what makes it
// worth refusing up front rather than debugging afterwards.

/**
 * Throws when the runtime at the environment's gatewayOrigin already has a viewer.
 * Silent when the runtime predates the `viewers` field or is simply unreachable —
 * the preflight health checks already own reachability, and this must never be the
 * thing that fails a run for a network blip.
 */
export async function refuseBusyRuntime(loadedEnvironment, { env = process.env, fetchImpl = fetch } = {}) {
  if (env.POPCORN_HARNESS_ALLOW_SHARED_RUNTIME === '1') return null;
  const origin = loadedEnvironment?.value?.popcorn?.liveview?.gatewayOrigin;
  if (!origin) return null;
  let payload;
  try {
    const response = await fetchImpl(new URL('/geometry', origin), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    return null;
  }
  if (!Number.isFinite(payload?.viewers) || payload.viewers === 0) return payload ?? null;
  throw new Error(
    `Browser runtime already has ${payload.viewers} viewer(s) attached at ${origin}. `
    + "Two runs share one X screen and resize it under each other, which corrupts both runs' evidence. "
    + 'Wait for the other run to finish, or set POPCORN_HARNESS_ALLOW_SHARED_RUNTIME=1 to proceed anyway.',
  );
}
