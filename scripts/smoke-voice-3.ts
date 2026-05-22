import { TWIN_YE_SYSTEM_PROMPT } from '../src/prompts/twin-ye.v2.js';
import { callAnthropic } from '../src/integrations/anthropic.js';
import { pool, closePool } from '../src/db/client.js';

const ideas = [
  'Как Анна Кацапова подняла чек с 50 до 350 тысяч за 6 месяцев. Метод позиционирования.',
  'Почему дизайнеры теряют клиентов после первого проекта. Авторский надзор и право на присутствие.',
  'Авторский надзор — это не услуга, это позиция дизайнера, который продал не чертежи а спокойный въезд.',
];

const FORBIDDEN_HARD = [
  'дело в том',
  'таким образом',
  'возможно',
  'следует отметить',
  'хочу поделиться',
  'вступай в клуб',
  'жду тебя в реализации',
  'купи курс',
  'УТП',
  'mossebo',
  'MOSSEBO',
];

(async () => {
  let allPass = true;
  for (let i = 0; i < ideas.length; i++) {
    const ideaText = ideas[i]!;
    console.log(`\n========== IDEA ${i + 1} ==========`);
    console.log(ideaText);
    console.log();
    const r = await callAnthropic({
      mode: 'generative',
      system: TWIN_YE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Напиши пост-каркас для Telegram-канала на тему:\n\n${ideaText}\n\nДлина 800–1200 знаков. Code_word для CTA нет — закрой риторическим вопросом или формулой.`,
        },
      ],
      maxTokens: 2500,
      temperature: 0.75,
      traceTag: 'smoke-twin-ye-v2',
    });
    const text = r.text.trim();
    console.log(text);
    console.log();
    const low = text.toLowerCase();
    const hits = FORBIDDEN_HARD.filter((m) => low.includes(m.toLowerCase()));
    if (hits.length > 0) {
      console.log(`❌ FORBIDDEN HITS: ${hits.join(', ')}`);
      allPass = false;
    } else {
      console.log(`✅ no forbidden markers`);
    }
    // Required marker check — at least 1 of YE characteristic phrases
    const reqMarkers = ['так вот', 'и всё', 'вот тогда', 'подождите', 'горжусь', 'точка.', 'не нагло', 'это не'];
    const reqHits = reqMarkers.filter((m) => low.includes(m));
    console.log(`required markers found: [${reqHits.join(', ') || 'NONE'}]`);
    if (reqHits.length === 0) {
      console.log('⚠️ no characteristic markers — text may sound generic');
      allPass = false;
    }
  }
  console.log(`\n========== ${allPass ? '✅ ALL 3 PASS' : '⚠️ SOME FAILS — review above'} ==========`);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', (e as Error).message); process.exit(1); })
  .finally(() => closePool());
