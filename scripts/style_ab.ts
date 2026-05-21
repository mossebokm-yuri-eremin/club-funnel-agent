// A/B style-transfer test.
// A: current prompt (heavy directive) + 1 ref slide
// B: minimal prompt + 1 ref slide
// C: minimal prompt + ref slide + portrait
import { selectCarouselReferences } from '../src/services/carousel-template-selector.js';
import { generateGptunnelImage, downloadGptunnelImage } from '../src/integrations/gptunnel-creative.js';
import { writeFileSync } from 'node:fs';

const PROMPT_HEAVY = `Premium minimalist editorial photography, 9:16 vertical, magazine-quality.
Role: opening cover slide of an Instagram carousel — strong visual hook with negative space at top for headline overlay.
Visual metaphor hint: stack of design books, soft warm light.
Composition: clean, lots of negative space.
Color palette: warm orange #ff7518 accent, graphite #2C2826, warm beige paper #dfdbd8.
Light: soft warm directional light.
Style references: Kinfolk magazine, Cereal magazine.`;

const PROMPT_LIGHT = `Cover slide for Instagram carousel about money/income for interior designers.
Strong visual hook with empty space at top for headline text overlay.
Copy the style, color palette, typography, and composition of the reference images.`;

const PROMPT_BLIND = `Match the style, colors, composition, mood and typography of the reference images exactly.
This should look like another slide from the same carousel as the references.
Leave empty space at top for headline text overlay.`;

(async () => {
  const refs = await selectCarouselReferences({
    templateFolderName: 'carousel-03-money',
    voice: 'YE',
    includePortrait: false,
    includePastPost: false,
  });
  if (!refs || refs.refs.length === 0) {
    console.log('no refs');
    return;
  }
  console.log(`refs: ${refs.refs.length}, totalBytes=${refs.refs.reduce((a,r)=>a+r.bytes,0)}`);

  const refImages = refs.refs.map(r => r.dataUrl);

  for (const [label, prompt] of [
    ['A_heavy', PROMPT_HEAVY],
    ['B_light', PROMPT_LIGHT],
    ['C_blind', PROMPT_BLIND],
  ] as const) {
    console.log(`\n=== ${label} ===`);
    const r = await generateGptunnelImage({ prompt, aspectRatio: '9:16', size: '2K', referenceImages: refImages });
    console.log(`  url=${r.imageUrl}  cost=${r.costRub} rub  ${r.durationMs}ms`);
    const png = await downloadGptunnelImage(r.imageUrl);
    writeFileSync(`/var/www/cdn/__ab/${label}.jpg`, png);
    console.log(`  saved → https://agent.yury-eremin.ru/cdn/__ab/${label}.jpg`);
  }
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });
