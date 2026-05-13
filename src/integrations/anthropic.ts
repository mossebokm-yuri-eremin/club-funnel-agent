// Клиент к Claude API. SPEC §6.11.
// Поддерживает три семейства вызовов: GENERATIVE (Sonnet), THINKING (Opus +
// extended thinking), FAST (Haiku). Параметры модели и thinking-бюджета —
// из src/config.ts (фиксируются в .env, см. CLAUDE.md «секреты»).
//
// Что обещает контракт:
//  - retry 3× с экспоненциальной задержкой на 429/5xx/network;
//  - логирование usage (input/output/thinking tokens + оценка стоимости в USD);
//  - возврат сцепленного текста ассистента и сырого usage для трейсинга.

import Anthropic from '@anthropic-ai/sdk';
import type {
  Message,
  MessageParam,
  TextBlockParam,
  Usage,
  ContentBlock,
} from '@anthropic-ai/sdk/resources/messages.js';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

export type AnthropicMode = 'generative' | 'thinking' | 'fast';

export interface AnthropicCallOptions {
  mode: AnthropicMode;
  system: string | TextBlockParam[];
  messages: MessageParam[];
  maxTokens?: number;
  temperature?: number;
  /** Если задано — перекрывает ANTHROPIC_THINKING_BUDGET_TOKENS. Игнорируется не в thinking-режиме. */
  thinkingBudgetTokens?: number;
  /** Тэг для логов (например, 'longread-writer', 'strategy-chooser') */
  traceTag?: string;
}

export interface AnthropicCallResult {
  text: string;
  thinkingText: string;
  usage: Usage;
  stopReason: Message['stop_reason'];
  model: string;
  raw: Message;
  costUsd: number;
}

// Прайс-лист (USD per 1M tokens). При апгрейде моделей обновлять руками.
// Источник — SPEC §13 (Cost estimation).
const PRICING_PER_MTOK: Record<string, { input: number; output: number }> = {
  // Opus 4.x
  'claude-opus-4-7': { input: 15, output: 75 },
  'claude-opus-4-6': { input: 15, output: 75 },
  // Sonnet 4.x
  'claude-sonnet-4-6': { input: 3, output: 15 },
  // Haiku 4.x
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

function pricingFor(model: string): { input: number; output: number } {
  const exact = PRICING_PER_MTOK[model];
  if (exact) return exact;
  if (model.startsWith('claude-opus')) return { input: 15, output: 75 };
  if (model.startsWith('claude-sonnet')) return { input: 3, output: 15 };
  if (model.startsWith('claude-haiku')) return { input: 1, output: 5 };
  return { input: 5, output: 25 };
}

export function estimateCostUsd(model: string, usage: Usage): number {
  const p = pricingFor(model);
  const inputTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const outputTokens = usage.output_tokens ?? 0;
  const cost = (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
  return Number(cost.toFixed(6));
}

function modelFor(mode: AnthropicMode): string {
  switch (mode) {
    case 'thinking':
      return config.ANTHROPIC_MODEL_THINKING;
    case 'fast':
      return config.ANTHROPIC_MODEL_FAST;
    case 'generative':
    default:
      return config.ANTHROPIC_MODEL_GENERATIVE;
  }
}

function defaultMaxTokens(mode: AnthropicMode): number {
  switch (mode) {
    case 'thinking':
      return 16_000;
    case 'fast':
      return 1_000;
    case 'generative':
    default:
      return 8_000;
  }
}

let _client: Anthropic | null = null;
export function getAnthropicClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return _client;
}

/** Перезаписывает singleton клиента — используется в тестах для инъекции мока. */
export function setAnthropicClient(client: Anthropic | null): void {
  _client = client;
}

function isRetriable(err: unknown): boolean {
  if (err instanceof Anthropic.APIError) {
    if (err.status === 429) return true;
    if (typeof err.status === 'number' && err.status >= 500) return true;
    return false;
  }
  // ECONNRESET / ETIMEDOUT / network errors
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') return true;
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function extractText(blocks: ContentBlock[]): { text: string; thinkingText: string } {
  let text = '';
  let thinkingText = '';
  for (const block of blocks) {
    if (block.type === 'text') {
      text += block.text;
    } else if (block.type === 'thinking') {
      thinkingText += block.thinking;
    }
  }
  return { text: text.trim(), thinkingText: thinkingText.trim() };
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 800;

export async function callAnthropic(opts: AnthropicCallOptions): Promise<AnthropicCallResult> {
  const model = modelFor(opts.mode);
  const maxTokens = opts.maxTokens ?? defaultMaxTokens(opts.mode);
  const client = getAnthropicClient();

  const params: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: maxTokens,
    system: opts.system,
    messages: opts.messages,
  };
  if (opts.temperature !== undefined) params.temperature = opts.temperature;
  if (opts.mode === 'thinking') {
    const budget = opts.thinkingBudgetTokens ?? config.ANTHROPIC_THINKING_BUDGET_TOKENS;
    // opus-4-7+ требует новый формат: thinking.type='adaptive' + output_config.effort.
    // Старый enabled+budget_tokens оставляем для sonnet-4-6 / haiku-4-5.
    if (/opus-4-7|opus-5|sonnet-4-7|sonnet-5/.test(model)) {
      const effort: 'low' | 'medium' | 'high' =
        budget >= 12000 ? 'high' : budget >= 4000 ? 'medium' : 'low';
      (params as unknown as Record<string, unknown>).thinking = { type: 'adaptive' };
      (params as unknown as Record<string, unknown>).output_config = { effort };
    } else {
      params.thinking = { type: 'enabled', budget_tokens: budget };
    }
    // temperature MUST be unset (or 1) with extended thinking
    delete params.temperature;
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const startedAt = Date.now();
      const message = await client.messages.create(params);
      const { text, thinkingText } = extractText(message.content);
      const costUsd = estimateCostUsd(model, message.usage);
      log.info(
        {
          tag: opts.traceTag,
          mode: opts.mode,
          model,
          attempts: attempt,
          stop_reason: message.stop_reason,
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
          cache_read: message.usage.cache_read_input_tokens,
          duration_ms: Date.now() - startedAt,
          cost_usd: costUsd,
        },
        'anthropic: call ok',
      );
      return {
        text,
        thinkingText,
        usage: message.usage,
        stopReason: message.stop_reason,
        model,
        raw: message,
        costUsd,
      };
    } catch (err) {
      lastErr = err;
      const retriable = isRetriable(err);
      const status = err instanceof Anthropic.APIError ? err.status : undefined;
      log.warn(
        {
          tag: opts.traceTag,
          mode: opts.mode,
          model,
          attempt,
          retriable,
          status,
          err: err instanceof Error ? err.message : String(err),
        },
        'anthropic: call failed',
      );
      if (!retriable || attempt === MAX_ATTEMPTS) break;
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(backoff);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Безопасный парсер JSON-ответа Claude. Вырезает обрамляющий markdown-кодблок, если есть. */
export function parseJsonResponse<T = unknown>(text: string): T {
  let payload = text.trim();
  // ```json ... ``` или ``` ... ```
  const fence = payload.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1]) payload = fence[1].trim();
  // Иногда модель добавляет prelude перед {...}. Берём от первой { до последней }.
  if (!payload.startsWith('{') && !payload.startsWith('[')) {
    const firstBrace = Math.min(
      ...[payload.indexOf('{'), payload.indexOf('[')].filter((i) => i >= 0),
    );
    if (Number.isFinite(firstBrace) && firstBrace >= 0) {
      payload = payload.slice(firstBrace);
    }
  }
  return JSON.parse(payload) as T;
}
