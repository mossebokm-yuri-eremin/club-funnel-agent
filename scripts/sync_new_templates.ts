// Качает все слайды из новой папки 1va-NJ5vLB... в /var/www/cdn/templates/ye/main-2026-05/
// и пишет в carousel_template_slides под carousel_name='main-2026-05'.
import { listFolderFiles, downloadFile } from '../src/integrations/gdrive.js';
import { pool, closePool } from '../src/db/client.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FOLDER_ID = '1va-NJ5vLBOChCLbDSg5M-cp94SFSh79K';
const CAROUSEL_NAME = 'main-2026-05';
const VOICE = 'ye';
const LOCAL_DIR = `/var/www/cdn/templates/${VOICE}/${CAROUSEL_NAME}`;
const PUBLIC_BASE = 'https://agent.yury-eremin.ru/cdn/templates';

function naturalSort(a: { name: string }, b: { name: string }): number {
  const an = parseInt(a.name.match(/\d+/)?.[0] ?? '0', 10);
  const bn = parseInt(b.name.match(/\d+/)?.[0] ?? '0', 10);
  return an !== bn ? an - bn : a.name.localeCompare(b.name);
}

(async () => {
  await mkdir(LOCAL_DIR, { recursive: true });
  const items = (await listFolderFiles(FOLDER_ID))
    .filter(f => f.mimeType.startsWith('image/'))
    .sort(naturalSort);
  console.log(`got ${items.length} image files`);
  let ok = 0;
  for (let i = 0; i < items.length; i++) {
    const f = items[i]!;
    const slideNumber = i + 1;
    const fname = `slide-${String(slideNumber).padStart(2, '0')}.jpg`;
    const localPath = path.join(LOCAL_DIR, fname);
    const publicUrl = `${PUBLIC_BASE}/${VOICE}/${CAROUSEL_NAME}/${fname}`;
    try {
      const buf = await downloadFile(f.id);
      await writeFile(localPath, buf);
      await pool.query(
        `INSERT INTO carousel_template_slides
           (voice, carousel_name, slide_number, drive_file_id, drive_filename,
            local_path, public_url, bytes, mime_type, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (voice, carousel_name, slide_number) DO UPDATE
           SET drive_file_id = EXCLUDED.drive_file_id, drive_filename = EXCLUDED.drive_filename,
               local_path = EXCLUDED.local_path, public_url = EXCLUDED.public_url,
               bytes = EXCLUDED.bytes, mime_type = EXCLUDED.mime_type, synced_at = NOW()`,
        [VOICE, CAROUSEL_NAME, slideNumber, f.id, f.name, localPath, publicUrl, buf.length, f.mimeType],
      );
      ok += 1;
      if (slideNumber % 10 === 0) console.log(`  ${slideNumber}/${items.length} ok`);
    } catch (err) {
      console.log(`ERR slide ${slideNumber}: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  console.log(`\n=== DONE ${ok}/${items.length} → ${LOCAL_DIR} ===`);
  process.exit(0);
})().catch(e => { console.error('FAIL:', (e as Error).message); process.exit(1); })
  .finally(() => closePool());
