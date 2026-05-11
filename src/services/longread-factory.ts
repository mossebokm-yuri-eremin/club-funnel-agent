// longread-factory — SPEC §2.6 (AC-16..18).
//
// Генерирует лонгрид по структуре StoryBrand SB7 / VSL (14 блоков) для стратегии C.
// Использует LONGREAD_WRITER (Opus + extended thinking). Прогон через VOICE VALIDATOR.
//
// ЗАПИСЬ В BONUS_LIBRARY ОТЛОЖЕНА НА PHASE 4. Согласно SPEC AC-18 запись со
// status='live' допустима ТОЛЬКО после успешного рендера PDF (Puppeteer) и загрузки
// в Google Drive (URL/gdrive_id заполнены реальными значениями). Текущая фабрика
// возвращает `bodyMd` caller'у — в Phase 4 будет PDF-render-job, который и сохранит
// строку в bonus_library со всеми финальными полями.

import type { Pool } from 'pg';
import { callAnthropic } from '../integrations/anthropic.js';
import { LONGREAD_WRITER_SYSTEM_PROMPT } from '../prompts/longread-writer.v1.js';
import { validateVoice, type VoiceValidatorReport } from './voice-validator.js';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

export interface LongreadOutlineSection {
  h2: string;
  summary: string;
}

export interface LongreadInput {
  ideaId: string;
  title: string;
  outline: LongreadOutlineSection[];
  painTag: string;
  codeWord: string;
  /** Опционально — выдержки wiki и winning_patterns как контекст. */
  knowledgeExcerpts?: string[];
  winningPatterns?: string[];
}

export interface LongreadResult {
  /** UUID записи в bonus_library. Phase 3 всегда возвращает null — запись будет в Phase 4
   *  (после рендера PDF и загрузки в GDrive). См. SPEC AC-18. */
  bonusId: string | null;
  bodyMd: string;
  wordCount: number;
  report: VoiceValidatorReport;
  attempts: number;
  escalated: boolean;
  costUsd: number;
}

export interface LongreadFactoryDeps {
  pool: Pool;
  callLlm?: typeof callAnthropic;
  maxRetries?: number;
}

function countWords(text: string): number {
  const tokens = text.trim().match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu);
  return tokens ? tokens.length : 0;
}

function buildUserMessage(input: LongreadInput, feedback?: string): string {
  const lines: string[] = [];
  lines.push(`Заголовок (одобрен Юрием): ${input.title}`);
  lines.push(`Боль: ${input.painTag}`);
  lines.push(`Кодовое слово воронки: ${input.codeWord}`);
  lines.push('');
  lines.push('Структура (одобрена Юрием):');
  for (const s of input.outline) {
    lines.push(`  ## ${s.h2}`);
    lines.push(`     ${s.summary}`);
  }
  if (input.knowledgeExcerpts && input.knowledgeExcerpts.length > 0) {
    lines.push('');
    lines.push('Контекст из wiki:');
    for (const ex of input.knowledgeExcerpts.slice(0, 5)) {
      lines.push(`  • ${ex}`);
    }
  }
  if (input.winningPatterns && input.winningPatterns.length > 0) {
    lines.push('');
    lines.push('Винии-паттерны (вдохновляйся, не копируй):');
    for (const w of input.winningPatterns.slice(0, 3)) {
      lines.push(`  • ${w}`);
    }
  }
  lines.push('');
  lines.push(
    `ОБЪЁМ: ${config.LONGREAD_MIN_WORDS}–${config.LONGREAD_MAX_WORDS} слов. Меньше — слишком сжато, больше — теряем фокус.`,
  );
  if (feedback) {
    lines.push('');
    lines.push('---');
    lines.push(feedback);
  }
  return lines.join('\n');
}

function feedbackFromReport(report: VoiceValidatorReport): string {
  const parts: string[] = ['ПРОШЛАЯ ВЕРСИЯ НЕ ПРОШЛА VOICE VALIDATOR.'];
  if (report.violations.length > 0) {
    parts.push(
      `Найдены запрещённые слова: ${report.violations.map((v) => v.marker).join(', ')}. Заменить.`,
    );
  }
  if (report.density_per_100w < config.VOICE_VALIDATOR_MIN_DENSITY) {
    parts.push(
      `Плотность YE-маркеров ${report.density_per_100w} < ${config.VOICE_VALIDATOR_MIN_DENSITY}. ` +
        `Добавь вкрапления: ${report.missingMarkers.slice(0, 5).join(', ')}.`,
    );
  }
  if (report.reason) parts.push(`Причина: ${report.reason}.`);
  parts.push('Сохрани структуру и смысл. Поправь только язык. Не извиняйся, не комментируй.');
  return parts.join('\n');
}

export async function generateLongread(
  input: LongreadInput,
  deps: LongreadFactoryDeps,
): Promise<LongreadResult> {
  const llm = deps.callLlm ?? callAnthropic;
  const totalAttempts = Math.max(1, deps.maxRetries ?? config.VOICE_VALIDATOR_MAX_RETRIES);

  let lastText = '';
  let lastReport: VoiceValidatorReport | null = null;
  let costSum = 0;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const feedback = attempt > 1 && lastReport ? feedbackFromReport(lastReport) : undefined;
    const response = await llm({
      mode: 'thinking',
      system: LONGREAD_WRITER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(input, feedback) }],
      traceTag: 'longread-factory',
      maxTokens: 16000,
    });
    costSum += response.costUsd;
    lastText = response.text.trim();
    const report = validateVoice({ text: lastText, voice: 'YE' });
    lastReport = report;

    if (report.ok) {
      const wordCount = countWords(lastText);
      // Если длина далека от диапазона — отметим, но не блокируем (caller решает).
      if (wordCount < config.LONGREAD_MIN_WORDS || wordCount > config.LONGREAD_MAX_WORDS) {
        log.warn(
          { ideaId: input.ideaId, wordCount, attempt },
          'longread-factory: word_count out of target range',
        );
      }
      // SPEC AC-18: в bonus_library пишем ТОЛЬКО после рендера PDF + загрузки в GDrive.
      // Запись отложена на Phase 4 (PDF-render-job получит bodyMd и сохранит финальную строку).
      log.info(
        { ideaId: input.ideaId, wordCount, attempts: attempt, cost_usd: costSum },
        'longread-factory: body generated (DB write deferred to Phase 4 PDF render)',
      );
      return {
        bonusId: null,
        bodyMd: lastText,
        wordCount,
        report,
        attempts: attempt,
        escalated: false,
        costUsd: costSum,
      };
    }

    log.warn(
      {
        ideaId: input.ideaId,
        attempt,
        density: report.density_per_100w,
        reason: report.reason,
        violations: report.violations.map((v) => v.marker),
      },
      'longread-factory: voice validator failed, retrying',
    );
  }

  // Все попытки израсходованы → эскалация. Возвращаем последний draft без записи в БД.
  return {
    bonusId: null,
    bodyMd: lastText,
    wordCount: countWords(lastText),
    report:
      lastReport ?? {
        voice_code: 'YE',
        ok: false,
        violations: [],
        missingMarkers: [],
        required_markers_found: [],
        density_per_100w: 0,
        score: 0,
        word_count: 0,
        reason: 'no attempts produced output',
      },
    attempts: totalAttempts,
    escalated: true,
    costUsd: costSum,
  };
}
