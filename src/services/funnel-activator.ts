// funnel-activator — активирует воронку при approve content_package (AC-27).
//
// Phase 11 (MCP): использует ChatPlace MCP вместо мёртвого REST.
//   1. Генерит code_word (8 символов, привязан к pain_tag).
//   2. INSERT в funnels (status='live').
//   3. Через MCP automations_quick_setup создаёт IG-автоматизацию (сразу Active):
//      trigger=messageContains code_word → welcome → link на наш TG-бот ?start=<code_word>
//      Стратегии A/C: PDF-ссылка в welcomeMessage. B: только TG-канал.
//   4. quick_setup id не отдаёт → поднимаем через automations_list по startMessages/name.
//   5. UPDATE funnels.chatplace_automation_id.
//   6. funnel_events.event_type='longread_offered' | 'club_offered'.
//
// Best-effort: если MCP упал — funnel запись остаётся live, automationId=null.

import type { Pool } from 'pg';
import { config } from '../config.js';
import { log } from '../observability/logger.js';
import { botsList, automationsQuickSetup, mcpToolCall } from '../integrations/chatplace-mcp.js';
import { generateUniqueCodeWord } from './code-word-generator.js';
import { trackEvent } from './funnel.js';

export interface ActivateFunnelInput {
  ideaId: string;
  contentPackageId: string;
}

export interface ActivateFunnelResult {
  funnelId: string;
  codeWord: string;
  chatplaceAutomationId: string | null;
  status: 'live' | 'draft';
}

let cachedIgBotId: string | null = null;

async function resolveIgBotId(): Promise<string | null> {
  if (config.CHATPLACE_IG_BOT_ID) return config.CHATPLACE_IG_BOT_ID;
  if (cachedIgBotId) return cachedIgBotId;
  try {
    const bots = await botsList();
    const ig = bots.find((b) => b.platform?.label === 'instagram');
    if (ig) {
      cachedIgBotId = ig.id;
      log.info({ botId: ig.id, name: ig.name, username: ig.username }, 'chatplace-mcp: IG bot resolved');
      return ig.id;
    }
    log.warn({ count: bots.length }, 'chatplace-mcp: no Instagram bot in account');
    return null;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'chatplace-mcp: bots_list failed');
    return null;
  }
}

export async function activateFunnelOnApprove(
  pool: Pool,
  input: ActivateFunnelInput,
): Promise<ActivateFunnelResult | null> {
  // 1. Идемпотентность.
  const existing = await pool.query<{
    id: string;
    code_word: string;
    chatplace_automation_id: string | null;
    status: 'draft' | 'live' | 'paused' | 'archived';
  }>(
    `SELECT id, code_word, chatplace_automation_id, status
       FROM funnels WHERE idea_id = $1
       ORDER BY created_at DESC LIMIT 1`,
    [input.ideaId],
  );
  if (existing.rows.length > 0 && existing.rows[0]?.status === 'live') {
    const r = existing.rows[0];
    log.info(
      { ideaId: input.ideaId, funnelId: r.id, codeWord: r.code_word },
      'funnel-activator: already active, skipping',
    );
    return {
      funnelId: r.id,
      codeWord: r.code_word,
      chatplaceAutomationId: r.chatplace_automation_id,
      status: r.status as 'live',
    };
  }

  // 2. Idea + bonus.
  const ideaRes = await pool.query<{
    id: string;
    strategy: 'A' | 'B' | 'C' | null;
    pain_tag: string | null;
    bonus_id: string | null;
    summary: string | null;
  }>(
    `SELECT id, strategy, pain_tag, bonus_id, summary FROM ideas WHERE id = $1`,
    [input.ideaId],
  );
  const idea = ideaRes.rows[0];
  if (!idea) {
    log.warn({ ideaId: input.ideaId }, 'funnel-activator: idea not found');
    return null;
  }
  if (!idea.strategy) {
    log.warn({ ideaId: input.ideaId }, 'funnel-activator: idea.strategy is null, skipping');
    return null;
  }

  let bonusPdfUrl: string | null = null;
  let bonusTitle: string | null = null;
  if (idea.strategy !== 'B' && idea.bonus_id) {
    const bRes = await pool.query<{ pdf_url: string; title: string }>(
      `SELECT pdf_url, title FROM bonus_library
        WHERE id = $1 AND status = 'live' AND deleted_at IS NULL`,
      [idea.bonus_id],
    );
    if (bRes.rows[0]) {
      bonusPdfUrl = bRes.rows[0].pdf_url;
      bonusTitle = bRes.rows[0].title;
    }
  }

  // 3. code_word.
  const codeWord = await generateUniqueCodeWord(
    pool,
    idea.pain_tag ? { painSeed: idea.pain_tag } : {},
  );
  log.info({ ideaId: input.ideaId, codeWord, strategy: idea.strategy }, 'funnel-activator: code_word');

  // 4. INSERT funnels.
  const funnelIns = await pool.query<{ id: string }>(
    `INSERT INTO funnels (idea_id, code_word, strategy, bonus_id, status)
     VALUES ($1, $2, $3, $4, 'live')
     RETURNING id`,
    [input.ideaId, codeWord, idea.strategy, idea.bonus_id],
  );
  const funnelId = funnelIns.rows[0]!.id;

  // 5. ChatPlace MCP.
  let chatplaceAutomationId: string | null = null;
  try {
    const botId = await resolveIgBotId();
    if (!botId) {
      log.warn({ funnelId, codeWord }, 'funnel-activator: no IG bot, skipping ChatPlace setup');
    } else {
      const tgBotLink = `https://t.me/${(config.TELEGRAM_BOT_USERNAME ?? 'Realizacia_marketing_bot').replace(/^@/, '')}?start=${codeWord}`;
      const isClub = idea.strategy === 'B';
      const welcomeMessage = isClub
        ? `Привет! Я Юрий Еремин. Спасибо за «${codeWord}». Все материалы и сообщество — в моём Telegram.`
        : `Привет! Спасибо за «${codeWord}». Сейчас отправлю ${bonusTitle ? `лонгрид «${bonusTitle}»` : 'материалы'} и приглашу в TG-канал.`;
      const messageWithLink = isClub
        ? `Заходи в TG-канал клуба «Реализация» — внутри живые встречи, разборы и сообщество.`
        : `${bonusPdfUrl ? `Лонгрид: ${bonusPdfUrl}\n\n` : ''}Когда прочитаешь — заходи в TG-канал клуба «Реализация».`;

      const qs = await automationsQuickSetup({
        botId,
        triggerType: 'messageContains',
        startMessages: [codeWord],
        templateType: 'base',
        welcomeMessage,
        welcomeButton: isClub ? 'Перейти в Telegram' : 'Получить материалы',
        messageWithLink,
        buttonText: 'Открыть Telegram',
        buttonLink: tgBotLink,
      });
      const qsOk =
        (qs as { success?: boolean }).success === true ||
        (qs as { id?: string }).id !== undefined;
      if (!qsOk) {
        log.warn(
          { funnelId, codeWord, raw: JSON.stringify(qs).slice(0, 200) },
          'funnel-activator: quick_setup non-success response',
        );
      } else {
        // quick_setup сразу делает automation Active, id в ответе не отдаёт.
        // Резолвим через automations_list (startMessages содержит codeWord, name = «<CODEWORD_UPPER>» to Direct).
        try {
          const list = await mcpToolCall<Array<{ id: string; name: string; startMessages?: string[] }>>(
            'automations_list',
            { botId },
          );
          const upper = codeWord.toUpperCase();
          const found =
            list.find((a) => Array.isArray(a.startMessages) && a.startMessages.includes(codeWord)) ??
            list.find((a) => typeof a.name === 'string' && a.name.includes(upper));
          if (found) {
            chatplaceAutomationId = found.id;
            await pool.query(
              `UPDATE funnels SET chatplace_automation_id = $2, updated_at = NOW() WHERE id = $1`,
              [funnelId, chatplaceAutomationId],
            );
            log.info(
              { funnelId, codeWord, chatplaceAutomationId, automationName: found.name },
              'funnel-activator: ChatPlace automation resolved',
            );
          } else {
            log.warn(
              { funnelId, codeWord, listCount: list.length },
              'funnel-activator: quick_setup ok but automation not found in list',
            );
          }
        } catch (err) {
          log.warn(
            { err: (err as Error).message, funnelId, codeWord },
            'funnel-activator: automations_list failed (automation likely created but id unknown)',
          );
        }
      }
    }
  } catch (err) {
    log.warn(
      { err: (err as Error).message, funnelId, codeWord },
      'funnel-activator: ChatPlace MCP failed (funnel live, automation pending retry)',
    );
  }

  // 6. funnel_events.
  try {
    await trackEvent(
      {
        subscriberId: null,
        funnelId,
        codeWord,
        eventCode: idea.strategy === 'B' ? 'club_offered' : 'longread_offered',
        source: 'tg_bot',
        idempotencyKey: `funnel-active:${funnelId}`,
        payload: { strategy: idea.strategy, bonusId: idea.bonus_id },
      },
      { pool },
    );
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'funnel-activator: trackEvent failed (non-fatal)');
  }

  return {
    funnelId,
    codeWord,
    chatplaceAutomationId,
    status: 'live',
  };
}
