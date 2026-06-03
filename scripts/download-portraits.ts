import { listFolderFiles, downloadFile, getFolderIdByName } from '../src/integrations/gdrive.js';
import { config } from '../src/config.js';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';

const TARGETS: Array<{ folderName: string; localDir: string }> = [
  { folderName: '01-yuri-photos', localDir: '/var/www/cdn/yury-photos' },
  { folderName: '02-viktoriya-photos', localDir: '/var/www/cdn/viktoriya-photos' },
];

function cleanName(orig: string): string {
  // 'yuri-portrait-strict-01.jpg.JPG' → 'yuri-portrait-strict-01.jpg' (drop double-ext)
  let n = orig.replace(/\.(jpg|JPG|jpeg|JPEG|png|PNG|HEIC|heic)\.(jpg|JPG|jpeg|JPEG|png|PNG)$/i, '.jpg');
  n = n.replace(/\.HEIC$/i, '.heic');
  return n;
}

(async () => {
  const rootId = config.GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID!;
  for (const { folderName, localDir } of TARGETS) {
    await mkdir(localDir, { recursive: true });
    const subId = await getFolderIdByName(rootId, folderName);
    if (!subId) { console.log('SKIP ' + folderName + ' (not found)'); continue; }
    const items = (await listFolderFiles(subId)).filter(f => f.mimeType.startsWith('image/'));
    console.log('--- ' + folderName + ' --- ' + items.length + ' files');
    for (const f of items) {
      try {
        const out = cleanName(f.name);
        if (out.toLowerCase().endsWith('.heic')) {
          console.log('  SKIP HEIC ' + f.name);
          continue;
        }
        const buf = await downloadFile(f.id);
        await writeFile(join(localDir, out), buf);
        console.log('  OK  ' + out + ' (' + buf.length + ' bytes)');
      } catch (err) {
        console.log('  ERR ' + f.name + ': ' + (err as Error).message);
      }
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
