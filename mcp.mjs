/**
 * One connection to the hosted Proofable MCP server, authenticated with your access key.
 * The same server your MCP client (Claude, Cursor, Codex, VS Code) connects to.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export const MCP_URL = process.env.PROOFABLE_MCP_URL || 'https://mcp.proofable.me/mcp';
export const API_URL = process.env.PROOFABLE_API_URL || 'https://api.proofable.me';

export function accessKey() {
  const key = String(process.env.PROOFABLE_ACCESS_KEY || '').trim();
  if (!key.startsWith('npk_')) {
    throw new Error('Set PROOFABLE_ACCESS_KEY to an access key from https://proofable.me/profile?tab=account');
  }
  return key;
}

// Retry only a request that never reached the server. Once bytes are on the wire a tool may
// have run, and repeating a job create would start a second job.
const CONNECT_ERRORS = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);
export async function fetchWithRetry(url, init, attempts = 4) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, init);
    } catch (error) {
      const code = error?.cause?.code || error?.code;
      if (!CONNECT_ERRORS.has(code) || attempt >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function open() {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessKey()}` } },
    fetch: fetchWithRetry,
  });
  const next = new Client({ name: 'proofable-agent-starter', version: '1.1.0' });
  await next.connect(transport);
  return next;
}

/** Call one hosted tool and return its JSON result. A failed call carries that result as `error.body`. */
async function call(c, name, args) {
  const res = await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  const text = res.content?.find((part) => part.type === 'text')?.text || '';
  let body = res.structuredContent ?? null;
  if (!body && text) {
    try { body = JSON.parse(text); } catch { body = { message: text }; }
  }
  if (/INSUFFICIENT_CREDITS/.test(String(body?.error?.code || body?.error || body?.code || ''))) {
    throw new Error('This account is out of credits. Add credits at https://proofable.me/profile?tab=credits, then run again.');
  }
  if (res.isError) {
    const error = new Error(`${name}: ${String(body?.message || body?.error?.message || text).slice(0, 300)}`);
    error.body = body;
    throw error;
  }
  return body;
}

// The command line keeps one connection for the whole command. The promise is shared, so calls
// that start together (a job reads the owner and the permission at once) open it only once.
let client = null;

export function connect() {
  client ??= open().catch((error) => { client = null; throw error; });
  return client;
}

export async function tool(name, args = {}) {
  return call(await connect(), name, args);
}

export async function listTools() {
  return (await (await connect()).listTools()).tools;
}

export async function close() {
  if (!client) return;
  const c = await client.catch(() => null);
  client = null;
  await c?.close().catch(() => {});
}

/** The revision the hosted service reports, so a run names what it ran against. */
export async function serviceRevision() {
  try {
    const res = await fetchWithRetry(MCP_URL.replace(/\/mcp$/, '/health'), { signal: AbortSignal.timeout(15_000) });
    return (await res.json())?.release?.deploySha || null;
  } catch {
    return null;
  }
}
