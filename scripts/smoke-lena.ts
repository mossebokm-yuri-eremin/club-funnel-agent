import { TWIN_YE_SYSTEM_PROMPT } from '../src/prompts/twin-ye.v2.js';
import { TWIN_RZ_SYSTEM_PROMPT } from '../src/prompts/twin-rz.v2.js';
import { callAnthropic } from '../src/integrations/anthropic.js';
import { validateVoice } from '../src/services/voice-validator.js';

const ideaSummary = 'Дорогой чек делает позиционирование и смыслы, а не статусный офис и раздутая команда — это иллюзия, которая держит дизайнера в минусе.';

console.log('=== IDEA ===');
console.log(ideaSummary);

(async () => {
  console.log('\n========== YE POST ==========');
  const ye = await callAnthropic({
    mode: 'generative',
    system: TWIN_YE_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Напиши пост для Telegram на тему:

${ideaSummary}

Длина 800-1200 знаков. CTA нет — закрой риторическим вопросом или формулой.
ВАЖНО: НЕ используй формулировки \"дорогой чек\" / \"дешёвый клиент\" / \"оказывать услуги\" / \"целевая аудитория\" / \"ЦА\". Используй \"высокий чек\" / \"платёжеспособный клиент\" / \"делать дизайн\" / \"аудитория\".`,
    }],
    maxTokens: 2000,
    temperature: 0.75,
    traceTag: 'smoke-lena-ye',
  });
  console.log(ye.text.trim());

  const ye_v = validateVoice({ text: ye.text, voice: 'YE' });
  console.log('\n--- YE VOICE VALIDATOR ---');
  console.log('OK:', ye_v.ok);
  console.log('Density:', ye_v.score);
  console.log('Violations:', ye_v.violations.map(v=>v.marker).join(' | ') || 'none');

  console.log('\n\n========== RZ POST ==========');
  const rz = await callAnthropic({
    mode: 'generative',
    system: TWIN_RZ_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Напиши пост от Виктории-куратора на тему:

${ideaSummary}

Длина 800-1200 знаков. С конкретной резиденткой клуба, её именем и цифрой. CTA нет.
ВАЖНО: НЕ используй \"дорогой чек\" / \"дешёвый клиент\" / \"оказывать услуги\" / \"целевая аудитория\".`,
    }],
    maxTokens: 2000,
    temperature: 0.75,
    traceTag: 'smoke-lena-rz',
  });
  console.log(rz.text.trim());

  const rz_v = validateVoice({ text: rz.text, voice: 'RZ' });
  console.log('\n--- RZ VOICE VALIDATOR ---');
  console.log('OK:', rz_v.ok);
  console.log('Density:', rz_v.score);
  console.log('Violations:', rz_v.violations.map(v=>v.marker).join(' | ') || 'none');

  process.exit(0);
})();
