export async function readBoundedJsonBody(request: Request, maxBytes: number): Promise<{
  body?: unknown;
  error?: 'too_large' | 'malformed';
}> {
  const declared = request.headers.get('Content-Length');
  if (declared && Number.isFinite(Number(declared)) && Number(declared) > maxBytes) {
    return { error: 'too_large' };
  }
  if (!request.body) return { body: {} };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return { error: 'too_large' };
    }
    chunks.push(value);
  }
  if (!total) return { body: {} };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return { body: {} };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: 'malformed' };
  }
}
