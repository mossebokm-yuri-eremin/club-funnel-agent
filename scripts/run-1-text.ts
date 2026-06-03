// Quick retest of idea 2 carousel with new COMMON_STARTS whitelist.

import Anthropic from '@anthropic-ai/sdk';
import { pool, closePool } from '../src/db/client.js';
import { config } from '../src/config.js';
import { buildTwinYePrompt } from '../src/prompts/twin-ye.js';
import { buildCarouselTextPrompt } from '../src/prompts/carousel-text.js';
import { validateFacts } from '../src/services/voice-validator-v3.js';

const MODEL = config.ANTHROPIC_MODEL_GENERATIVE ?? 'claude-sonnet-4-6';
const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const IDEA = 'Почему дизайнеры теряют клиента после первого проекта';

async function call(system: string, user: string, max = 1800): Promise<string> {
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: max,
    temperature: 0.8,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const b = r.content.find((c) => c.type === 'text');
  return b && b.type === 'text' ? b.text.trim() : '';
}

(async () => {
  const yeBuilt = await buildTwinYePrompt(pool, { ideaText: IDEA });
  const ye = await call(yeBuilt.systemPrompt, `Идея: «${IDEA}»\nНапиши TG-пост 800-1200 символов.`);
  console.log('YE post:\n' + ye + '\n');

  const cBuilt = await buildCarouselTextPrompt({ ideaText: IDEA, yePost: ye, totalSlides: 10 });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = await call(cBuilt.systemPrompt, cBuilt.userPrompt, 1500);
    let arr: unknown;
    try {
      arr = JSON.parse(out.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim());
    } catch {
      console.log(`Attempt ${attempt}: invalid JSON`);
      continue;
    }
    if (!Array.isArray(arr)) continue;
    const slides = arr as string[];
    const fc = await validateFacts(slides.join('\n'), ye);
    console.log(`Attempt ${attempt}: factCheck ok=${fc.ok} names=[${fc.inventedNames.join(',')}] numbers=[${fc.inventedNumbers.join(',')}]`);
    if (fc.ok) {
      console.log('\n=== CAROUSEL ===');
      slides.forEach((s, i) => console.log(`${i + 1}. ${s}`));
      break;
    }
  }
  await closePool();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
