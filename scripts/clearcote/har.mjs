import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export function sanitizeURL(value) {
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[REDACTED]');
    url.pathname = url.pathname.replace(/(\/authn\/flows\/)[^/]+/, '$1[FLOW_ID]');
    return url.href;
  } catch { return ''; }
}

export function sanitizeHeaders(headers) {
  return Object.entries(headers || {}).map(([name, raw]) => {
    const key = name.toLowerCase();
    let value = String(raw);
    if (key === 'cookie') value = value.split(';').map(cookie => cookie.trim().split('=')[0] + '=[REDACTED]').join('; ');
    else if (key === 'set-cookie') value = value.replace(/(^|\n)([^=;\n]+)=[^;\n]*/g, '$1$2=[REDACTED]');
    else if (['referer', 'location'].includes(key)) value = sanitizeURL(value);
    else if (!/^(user-agent|accept|accept-language|accept-encoding|sec-ch-ua.*|sec-fetch-.*|content-type|content-length|host|origin|server|cache-control|pragma|expires|vary|connection|upgrade-insecure-requests|priority|:method|:scheme|:authority)$/.test(key)) value = '[REDACTED]';
    return { name, value };
  });
}

function errorSummary(body) {
  let data;
  try { data = JSON.parse(body); } catch {
    const encoded = body.match(/\bchallenge\s*=\s*["']([^"']+)["']/i)?.[1];
    if (encoded) try { data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); } catch { /* omit unknown bodies */ }
  }
  const summary = {};
  for (const field of ['code', 'errorCode', 'error', 'status', 'provider', 'sec-cp-challenge']) {
    if (typeof data?.[field] === 'string' && /^[a-z0-9_:-]{1,100}$/i.test(data[field])) summary[field] = data[field];
  }
  if (Number.isFinite(data?.chlg_duration)) summary.waitSeconds = data.chlg_duration;
  return summary;
}

export async function captureHAR(page, path) {
  await mkdir(dirname(path), { recursive: true });
  const entries = [];
  const requests = new Map();
  const earlyHeaders = new Map();
  let dirty = true;
  let writing = Promise.resolve();
  const flush = () => {
    if (!dirty) return writing;
    dirty = false;
    const document = JSON.stringify({ log: {
      version: '1.2', creator: { name: 'Popcorn sanitized CDP capture', version: '1.0' },
      comment: 'CDP normalizes header order; this is not wire-order or TLS evidence. Cookie values, queries, flow IDs and request bodies are redacted. Response bodies omitted except allowlisted error fields.',
      entries,
    } }, null, 2);
    writing = writing.catch(() => {}).then(async () => {
      await writeFile(path + '.tmp', document, { mode: 0o600 });
      await rename(path + '.tmp', path);
    });
    return writing;
  };
  const removeListener = page.onEvent(message => {
    const params = message.params || {};
    const id = params.requestId;
    if (message.method === 'Network.requestWillBeSent') {
      if (!/^https?:/.test(params.request.url)) return;
      const url = new URL(params.request.url);
      const entry = {
        startedDateTime: new Date(params.wallTime * 1000).toISOString(), time: 0,
        request: { method: params.request.method, url: sanitizeURL(url.href), httpVersion: '',
          headers: sanitizeHeaders(earlyHeaders.get(id) || params.request.headers), cookies: [],
          queryString: [...url.searchParams.keys()].map(name => ({ name, value: '[REDACTED]' })), headersSize: -1, bodySize: -1 },
        response: { status: 0, statusText: '', httpVersion: '', headers: [], cookies: [],
          content: { size: 0, mimeType: '' }, redirectURL: '', headersSize: -1, bodySize: -1 },
        cache: {}, timings: { send: 0, wait: 0, receive: 0 }, _resourceType: params.type,
      };
      earlyHeaders.delete(id);
      requests.set(id, { entry, start: params.timestamp });
      entries.push(entry);
    } else if (message.method === 'Network.requestWillBeSentExtraInfo') {
      const item = requests.get(id);
      if (item) item.entry.request.headers = sanitizeHeaders(params.headers);
      else earlyHeaders.set(id, params.headers);
    } else if (message.method === 'Network.responseReceived') {
      const item = requests.get(id);
      if (!item) return;
      const response = params.response;
      const version = ({ h2: 'HTTP/2', h3: 'HTTP/3' })[response.protocol] || response.protocol;
      item.entry.request.httpVersion = version;
      Object.assign(item.entry.response, { status: response.status, statusText: response.statusText,
        httpVersion: version, headers: sanitizeHeaders(response.headers), content: { size: 0, mimeType: response.mimeType } });
      if (response.timing) item.entry.timings.wait = Math.max(0, response.timing.receiveHeadersStart - response.timing.sendEnd);
    } else if (message.method === 'Network.responseReceivedExtraInfo') {
      const item = requests.get(id);
      if (item) item.entry.response.headers = sanitizeHeaders(params.headers);
    } else if (['Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) {
      const item = requests.get(id);
      if (!item) return;
      item.entry.time = Math.max(0, (params.timestamp - item.start) * 1000);
      item.entry.timings.receive = Math.max(0, item.entry.time - item.entry.timings.wait);
      if (params.errorText) item.entry._error = params.errorText;
      if (params.encodedDataLength) item.entry.response.bodySize = params.encodedDataLength;
      if (item.entry.response.status === 428 || (item.entry.response.status >= 400 && item.entry.request.url.includes('/authn/'))) {
        void page.send('Network.getResponseBody', { requestId: id }).then(result => {
          const body = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
          item.entry._errorSummary = errorSummary(body);
          item.entry.response.content.text = JSON.stringify(item.entry._errorSummary);
          item.entry.response.content._sanitized = true;
          dirty = true;
        }).catch(() => {});
      }
      requests.delete(id);
    } else return;
    dirty = true;
  });
  await flush();
  const timer = setInterval(() => { void flush().catch(() => console.error('HAR write failed')); }, 1000);
  return async () => { clearInterval(timer); removeListener(); dirty = true; await flush(); };
}
