// liveview-url.mjs — building the candidate URL for one pair.
//
// The candidate side loads the LiveView viewer inside the host page, so the URL is
// assembled from three sources: the session the control plane minted (which pod,
// which token), the environment's gateway (which front door), and the environment's
// host params (which viewer knobs). Kept in its own module because the ENCRYPTION
// case is easy to get silently wrong: a URL that quietly falls back to plaintext
// still runs, still records, still passes — while testing a transport no deployment
// uses. Every rule below therefore fails loudly instead.

const E2E = 'e2e';
// The control plane returns the viewer's e2e enrollment in the URL FRAGMENT: the
// session key, the pod's public key and the binding secret. A fragment is never
// sent to the gateway, which is the point — it reaches the viewer without the
// gateway ever being trusted with the material.
const BOOTSTRAP_PREFIX = 'popcorn-e2e=';

export function readEncryption(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value === E2E) return E2E;
  throw new Error(`liveview.encryption must be "${E2E}" when set, got ${JSON.stringify(value)}`);
}

// The bootstrap fragment as it must appear on the viewer URL, or null.
export function e2eBootstrap(vncUrl) {
  const hash = String(new URL(vncUrl).hash || '').replace(/^#/, '');
  return hash.startsWith(BOOTSTRAP_PREFIX) ? hash : null;
}

export function liveviewHostUrl({ vncUrl, gatewayOrigin, hostPage, hostParams = {}, encryption }) {
  const mode = readEncryption(encryption);
  const viewer = new URL(vncUrl);
  const bootstrap = e2eBootstrap(vncUrl);
  if (mode === E2E && !bootstrap) {
    // The session was allocated without liveViewEncryption, so the viewer would
    // load the plaintext transport and the run would silently measure the wrong
    // thing. Provisioning and this flag have to agree.
    throw new Error('liveview.encryption is "e2e" but the session URL carries no #popcorn-e2e bootstrap; provision the session with liveViewEncryption');
  }
  if (mode !== E2E && bootstrap) {
    throw new Error('the session URL carries an e2e bootstrap but liveview.encryption is not set; set it or provision a plaintext session');
  }

  const gateway = new URL(gatewayOrigin);
  viewer.protocol = gateway.protocol;
  viewer.host = gateway.host;
  // The host page appends the viewer page itself (liveview.html, or ?viewerpage=),
  // so what rides in ?viewer= is the directory, never the page.
  viewer.pathname = viewer.pathname.replace(/\/liveview\.html$/, '');
  // Both are rebuilt below from the environment rather than inherited: the viewer
  // knobs are the environment's to choose, and the fragment travels on the HOST
  // page's URL so the host's own hop can forward it down.
  viewer.search = '';
  viewer.hash = '';

  const host = new URL(hostPage);
  host.searchParams.set('viewer', viewer.toString());
  for (const [key, value] of Object.entries(hostParams)) {
    host.searchParams.set(key, String(value));
  }
  if (mode === E2E) {
    // `encryption` is a viewer knob (PopcornHost.VIEWER_PARAMS), so the host page
    // forwards it down every hop the same way it forwards magnify or diag. It comes
    // from the environment, not from hostParams, so a case cannot half-configure it.
    host.searchParams.set('encryption', E2E);
    host.hash = bootstrap;
  }
  return host.toString();
}
