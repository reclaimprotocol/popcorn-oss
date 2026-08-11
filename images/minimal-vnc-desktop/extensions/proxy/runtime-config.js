// Replaced in the container's private runtime extension copy when
// BROWSER_PROXY_URL is set. Values are base64 encoded to keep arbitrary proxy
// credentials out of generated JavaScript string syntax.
globalThis.POPCORN_PROXY_RUNTIME_CONFIG = Object.freeze({
  urlBase64: '',
  bypassBase64: '',
  controlPort: '6080'
});
