import { TOOL_DEFINITIONS, callTool, type ToolContext } from './tools';

/** JSON-RPC 2.0 handling for the MCP streamable-HTTP endpoint. */

export const PROTOCOL_VERSION = '2025-06-18';

export type JsonRpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any };
export type JsonRpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export async function handleRpc(ctx: ToolContext, request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return error(id, -32600, 'invalid request');
  }

  switch (request.method) {
    case 'initialize':
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'popcorn', title: 'Popcorn browser sessions', version: '0.1.0' },
        instructions:
          'Popcorn runs isolated, disposable cloud browsers. Call create_browser_session for a fixed block of browser time, preferring regions closest to the human and listing fallbacks nearest-first. Use proxy_country only when the task needs a particular network exit country. Then hand the live-view URL to the human for any login. If this deployment meters usage, get_balance reports remaining credit and a refused operation returns next_action telling the human how to obtain more.',
      });

    case 'notifications/initialized':
      return null;

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, { tools: TOOL_DEFINITIONS });

    case 'tools/call': {
      const name = request.params?.name;
      if (typeof name !== 'string') return error(id, -32602, 'params.name is required');
      const args = (request.params?.arguments ?? {}) as Record<string, any>;
      return result(id, await callTool(ctx, name, args));
    }

    default:
      return error(id, -32601, `method not found: ${request.method}`);
  }
}
