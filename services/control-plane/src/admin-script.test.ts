import { expect, test } from 'bun:test';

test('admin forms clear only after an explicitly successful htmx request', async () => {
  const script = await Bun.file(new URL('../public/assets/admin.js', import.meta.url)).text();
  const listeners = new Map<string, (event: any) => void>();
  const document = {
    body: {
      addEventListener(name: string, listener: (event: any) => void) {
        listeners.set(name, listener);
      },
    },
  };
  const htmx = { config: {} };
  new Function('document', 'htmx', script)(document, htmx);

  const afterRequest = listeners.get('htmx:afterRequest');
  expect(afterRequest).toBeDefined();
  let resetCount = 0;
  const form = {
    matches: (selector: string) => selector === '[data-clear-on-success]',
    reset: () => { resetCount += 1; },
  };

  afterRequest!({ detail: { elt: form } }); // Network errors may omit both flags.
  afterRequest!({ detail: { elt: form, failed: true } });
  afterRequest!({ detail: { elt: form, successful: false } });
  expect(resetCount).toBe(0);

  afterRequest!({ detail: { elt: form, successful: true } });
  expect(resetCount).toBe(1);
});
