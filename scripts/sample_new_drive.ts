import { listFolderFiles, downloadFile } from '../src/integrations/gdrive.js';
import { writeFile, mkdir } from 'node:fs/promises';

const FOLDER_ID = '1va-NJ5vLBOChCLbDSg5M-cp94SFSh79K';
const TARGET_NAMES = [
  'slide-01.jpg.jpg','slide-02.jpg.jpg',
  'slide-11.jpg.jpg','slide-12.jpg.jpg',
  'slide-21.jpg.jpg','slide-22.jpg.jpg',
  'slide-31.jpg.jpg','slide-32.jpg.jpg',
  'slide-41.jpg.jpg','slide-42.jpg.jpg',
];

(async () => {
  const dir = '/var/www/cdn/__new_drive_sample';
  await mkdir(dir, { recursive: true });
  const items = await listFolderFiles(FOLDER_ID);
  for (const name of TARGET_NAMES) {
    const f = items.find(x => x.name === name);
    if (!f) { console.log(`MISSING: ${name}`); continue; }
    const buf = await downloadFile(f.id);
    const out = `${dir}/${name.replace('.jpg.jpg', '.jpg')}`;
    await writeFile(out, buf);
    console.log(`https://agent.yury-eremin.ru/cdn/__new_drive_sample/${name.replace('.jpg.jpg', '.jpg')}  (${buf.length} bytes)`);
  }
  process.exit(0);
})().catch((e) => { console.error('FAIL:', (e as Error).message); process.exit(1); });
