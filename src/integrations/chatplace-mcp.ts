// ChatPlace MCP клиент — заменяет REST (api.chatplace.io умер).
// MCP endpoint: https://mcp.chatplace.io/mcp
//
// Жизненный цикл:
//   1. initialize  →  получаем session_id из ответа (или из header mcp-session-id)
//   2. notifications/initialized
//   3. tools/call …  — повторяем с тем же session_id
//
// Все ошибки выкидываем — funnel-activator поймает best-effort.

import { config } from '../config.js';
import { log } from '../observability/logger.js';

const MCP_URL = (process.env.CHATPLACE_MCP_URL ?? 'https://mcp.chatplace.io/mcp').replace(/\/$/, '');
const PROTOCOL_VERSION = '2025-06-18';
const REQUEST_TIMEOUT_MS = 30_000;

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id?: number | string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

let cachedSessionId: string | null = null;
let initializedAt = 0;
const SESSION_TTL_MS = 30 * 60_000;

function authHeader(): string {
  const key = config.CHATPLACE_API_KEY;
  if (!key) throw new Error('chatplace-mcp: CHATPLACE_API_KEY not set');
  return `Bearer ${key}`;
}

async function rawCall(
  method: string,
  params: Record<string, unknown> | undefined,
  sessionId: string | null,
  id: number,
): Promise<{ json: JsonRpcResponse; sessionIdFromHeader: string | null }> {
  const headers: Record<string, string> = {
    Authorization: authHeader(),
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'mcp-protocol-version': PROTOCOL_VERSION,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(MCP_URL, { method: 'POST', headers, body, signal: controller.signal });
    const sid = res.headers.get('mcp-session-id');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`chatplace-mcp HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    let json: JsonRpcResponse;
    if (ct.includes('text/event-stream')) {
      // SSE: pull первый data: chunk
      const txt = await res.text();
      const line = txt.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? '';
      json = JSON.parse(line) as JsonRpcResponse;
    } else {
      json = (await res.json()) as JsonRpcResponse;
    }
    return { json, sessionIdFromHeader: sid };
  } finally {
    clearTimeout(timer);
  }
}

async function notifyInitialized(sessionId: string): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: authHeader(),
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'mcp-protocol-version': PROTOCOL_VERSION,
    'mcp-session-id': sessionId,
  };
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await fetch(MCP_URL, { method: 'POST', headers, body }).catch(() => undefined);
}

async function ensureSession(): Promise<string> {
  if (cachedSessionId && Date.now() - initializedAt < SESSION_TTL_MS) {
    return cachedSessionId;
  }
  const { json, sessionIdFromHeader } = await rawCall(
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'club-funnel-agent', version: '0.1.0' },
    },
    null,
    Math.floor(Math.random() * 1_000_000),
  );
  if (json.error) {
    throw new Error(`chatplace-mcp initialize error ${json.error.code}: ${json.error.message}`);
  }
  // sessionId может прийти в header (по спецификации) или в result.serverInfo (некоторые сервера)
  const sid =
    sessionIdFromHeader ??
    (json.result as { sessionId?: string } | undefined)?.sessionId ??
    '';
  cachedSessionId = sid || null;
  initializedAt = Date.now();
  if (cachedSessionId) await notifyInitialized(cachedSessionId);
  log.debug(
    { sessionId: cachedSessionId ? cachedSessionId.slice(0, 12) + '…' : 'none' },
    'chatplace-mcp: initialized',
  );
  // Если sessionId не пришёл — продолжаем без него (некоторые MCP HTTP-сервера не требуют).
  return cachedSessionId ?? '';
}

export async function mcpToolCall<T = unknown>(
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const sid = await ensureSession();
  const { json } = await rawCall(
    'tools/call',
    { name, arguments: args },
    sid || null,
    Math.floor(Math.random() * 1_000_000),
  );
  if (json.error) {
    throw new Error(`chatplace-mcp tool=${name} error ${json.error.code}: ${json.error.message}`);
  }
  const tool = json.result as McpToolResult | undefined;
  if (tool?.isError) {
    const errTxt = tool.content?.[0]?.text ?? 'unknown error';
    throw new Error(`chatplace-mcp tool=${name} failed: ${errTxt.slice(0, 400)}`);
  }
  // ChatPlace возвращает результат в content[0].text как JSON-строку
  const txt = tool?.content?.[0]?.text;
  if (typeof txt !== 'string') {
    throw new Error(`chatplace-mcp tool=${name}: no text in response`);
  }
  try {
    return JSON.parse(txt) as T;
  } catch {
    return txt as unknown as T;
  }
}

// ─── High-level helpers ──────────────────────────────────────────────────────

export interface ChatPlaceBot {
  id: string;
  name: string;
  username: string;
  platform: { id: string; name: string; label: string };
}

export async function botsList(): Promise<ChatPlaceBot[]> {
  return mcpToolCall<ChatPlaceBot[]>('bots_list');
}

export interface QuickSetupArgs {
  botId: string;
  triggerType: 'messageContains' | 'messageEquals' | 'messageAnyValue' | 'commentContains' | 'commentEquals' | 'commentAnyValue';
  startMessages?: string[];
  templateType?: 'base' | 'checkSubscription';
  welcomeMessage: string;
  welcomeButton: string;
  messageWithLink: string;
  buttonText: string;
  buttonLink: string;
}

export interface QuickSetupResult {
  id?: string;
  automationId?: string;
  [k: string]: unknown;
}

export async function automationsQuickSetup(args: QuickSetupArgs): Promise<QuickSetupResult> {
  return mcpToolCall<QuickSetupResult>('automations_quick_setup', args as unknown as Record<string, unknown>);
}

export async function automationsChangeStatus(
  automationId: string,
  status: 'active' | 'paused',
): Promise<unknown> {
  return mcpToolCall('automations_change_status', { automationId, status });
}

/** Сбросить кэшированную сессию (для тестов / форс-реинит). */
export function clearChatPlaceMcpSession(): void {
  cachedSessionId = null;
  initializedAt = 0;
}
