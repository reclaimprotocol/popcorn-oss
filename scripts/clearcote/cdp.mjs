export async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); }, 10_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  const handlers = new Set();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const entry = pending.get(message.id);
    if (entry) {
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(entry.method + ': CDP command failed'));
      else entry.resolve(message.result);
    } else {
      for (const handler of handlers) handler(message);
    }
  });
  socket.addEventListener('close', () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('CDP connection closed'));
    }
    pending.clear();
  });
  return {
    socket,
    onEvent(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 25_000);
        pending.set(id, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

export async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error('Browser evaluation failed');
  return result.result?.value;
}

export async function diagnosticJSON(page, url, expectedField) {
  const endpoint = new URL(url);
  endpoint.searchParams.set('_pcn_check', String(Date.now()));
  const navigation = await page.send('Page.navigate', { url: endpoint.href });
  if (navigation.errorText) throw new Error(endpoint.hostname + ': navigation failed');
  for (let attempt = 0; attempt < 50; attempt++) {
    // Match the entire navigation URL so an old JSON document cannot satisfy a
    // later check against the same endpoint. Cache is also disabled by the caller.
    const expression = '(()=>{if(location.href!==' + JSON.stringify(endpoint.href) + ')return null;'
      + 'try{return JSON.parse(document.querySelector("pre")?.textContent||document.body.innerText)}catch{return null}})()';
    const data = await evaluate(page, expression);
    if (data && data[expectedField] !== undefined) return data;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(endpoint.hostname + ': diagnostic response unavailable');
}
