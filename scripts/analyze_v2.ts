import sharp from 'sharp';
import path from 'node:path';

const DIR = '/var/www/cdn/templates/ye/main-2026-05';

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
}

async function analyzeSlide(name: string): Promise<void> {
  const filepath = path.join(DIR, name);
  const meta = await sharp(filepath).metadata();
  const W = meta.width!;
  const H = meta.height!;
  console.log(`\n=== ${name}  (${W}×${H}) ===`);

  // Overall stats
  const stats = await sharp(filepath).stats();
  if (stats.dominant) {
    const { r, g, b } = stats.dominant;
    console.log(`  dominant      ${toHex(r, g, b)}`);
  }
  const meanR = stats.channels[0]!.mean;
  const meanG = stats.channels[1]!.mean;
  const meanB = stats.channels[2]!.mean;
  console.log(`  overall mean  ${toHex(meanR, meanG, meanB)}`);
  console.log(`  std-dev R/G/B  ${stats.channels[0]!.stdev.toFixed(0)} / ${stats.channels[1]!.stdev.toFixed(0)} / ${stats.channels[2]!.stdev.toFixed(0)}  (high stdev = много разнообразия)`);

  // Per-region — proper dynamic dimensions
  const regions = [
    { name: 'top-15%   ', left: 0,         top: 0,                 width: W, height: Math.floor(H * 0.15) },
    { name: 'top-band  ', left: 0,         top: Math.floor(H*0.15),width: W, height: Math.floor(H * 0.2) },
    { name: 'center    ', left: 0,         top: Math.floor(H*0.35),width: W, height: Math.floor(H * 0.3) },
    { name: 'bot-band  ', left: 0,         top: Math.floor(H*0.65),width: W, height: Math.floor(H * 0.2) },
    { name: 'bot-15%   ', left: 0,         top: Math.floor(H*0.85),width: W, height: Math.floor(H * 0.15) - 1 },
    { name: 'TL-corner ', left: 0,         top: 0,                 width: Math.floor(W*0.2), height: Math.floor(H*0.15) },
    { name: 'TR-corner ', left: Math.floor(W*0.8), top: 0,         width: Math.floor(W*0.2)-1, height: Math.floor(H*0.15) },
    { name: 'BL-corner ', left: 0,         top: Math.floor(H*0.85),width: Math.floor(W*0.2), height: Math.floor(H*0.15)-1 },
    { name: 'BR-corner ', left: Math.floor(W*0.8), top: Math.floor(H*0.85), width: Math.floor(W*0.2)-1, height: Math.floor(H*0.15)-1 },
  ];

  for (const reg of regions) {
    try {
      const buf = await sharp(filepath)
        .extract(reg)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const data = buf.data;
      const n = data.length / 3;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += 3) { r += data[i]!; g += data[i+1]!; b += data[i+2]!; }
      r /= n; g /= n; b /= n;
      console.log(`  ${reg.name} ${toHex(r,g,b)}`);
    } catch (e) {
      console.log(`  ${reg.name} ERR: ${(e as Error).message.slice(0, 80)}`);
    }
  }
}

(async () => {
  for (const name of ['slide-01.jpg', 'slide-02.jpg', 'slide-11.jpg', 'slide-21.jpg', 'slide-31.jpg', 'slide-41.jpg', 'slide-42.jpg']) {
    await analyzeSlide(name);
  }
  process.exit(0);
})().catch(e => { console.error('FAIL:', (e as Error).message); process.exit(1); });
