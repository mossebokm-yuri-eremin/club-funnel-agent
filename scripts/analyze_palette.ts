// Pixel-level анализ эталонных слайдов: dominant colors, mean RGB, размеры.
import sharp from 'sharp';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const DIR = '/var/www/cdn/templates/ye/main-2026-05';

interface Region { name: string; left: number; top: number; width: number; height: number; }

const W = 1080, H = 1350;
// Region sampling: cover assumes text at top, body at center, CTA at bottom.
const REGIONS: Region[] = [
  { name: 'top-50px',    left: 0,         top: 0,         width: W,       height: 50    },
  { name: 'top-strip',   left: 0,         top: 50,        width: W,       height: 300   },
  { name: 'center',      left: 0,         top: H / 3 | 0, width: W,       height: H / 3 | 0 },
  { name: 'bottom-strip',left: 0,         top: H - 350,   width: W,       height: 300   },
  { name: 'bottom-50px', left: 0,         top: H - 50,    width: W,       height: 50    },
];

async function analyzeSlide(filepath: string): Promise<void> {
  const meta = await sharp(filepath).metadata();
  console.log(`\n--- ${path.basename(filepath)}  (${meta.width}×${meta.height} ${meta.format}) ---`);
  // overall dominant via stats
  const stats = await sharp(filepath).stats();
  if (stats.dominant) {
    const { r, g, b } = stats.dominant;
    const hex = '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
    console.log(`  dominant overall: ${hex} (r=${r} g=${g} b=${b})`);
  }
  // per-region mean RGB
  for (const reg of REGIONS) {
    try {
      const { data, info } = await sharp(filepath)
        .extract({ left: reg.left, top: reg.top, width: reg.width, height: reg.height })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let r = 0, g = 0, b = 0;
      const pixels = info.width * info.height;
      for (let i = 0; i < data.length; i += 3) {
        r += data[i]!;
        g += data[i + 1]!;
        b += data[i + 2]!;
      }
      r = Math.round(r / pixels);
      g = Math.round(g / pixels);
      b = Math.round(b / pixels);
      const hex = '#' + [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('');
      console.log(`  ${reg.name.padEnd(14)} mean: ${hex} (r=${r} g=${g} b=${b})`);
    } catch (e) {
      console.log(`  ${reg.name.padEnd(14)} ERR: ${(e as Error).message.slice(0, 80)}`);
    }
  }
}

(async () => {
  // Берём 1, 2, 11, 21, 31, 41, 42 — cover каждой потенциальной группы + последний.
  const targets = ['slide-01.jpg', 'slide-02.jpg', 'slide-11.jpg', 'slide-21.jpg', 'slide-31.jpg', 'slide-41.jpg', 'slide-42.jpg'];
  for (const name of targets) {
    await analyzeSlide(path.join(DIR, name));
  }
  process.exit(0);
})().catch(e => { console.error('FAIL:', (e as Error).message); process.exit(1); });
