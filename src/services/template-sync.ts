// template-sync — скачивает эталонные слайды из GDrive в /var/www/cdn/templates/<carousel>/
// и пишет records в carousel_template_slides. Запускается:
//   - вручную: tsx scripts/sync-templates.ts
//   - cron: раз в день (TODO)
//
// nginx раздаёт /var/www/cdn/templates/ → https://agent.yury-eremin.ru/cdn/templates/<carousel>/<slide>
// → этот URL передаётся в nano-banana-2 как base image для edit.

import type { Pool } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  listFolderFiles,
  getFolderIdByName,
  downloadFile,
  type GDriveFileMeta,
} from '../integrations/gdrive.js';
import { config } from '../config.js';
import { log } from '../observability/logger.js';

const TEMPLATES_DIR = process.env.CAROUSEL_TEMPLATES_LOCAL_DIR ?? '/var/www/cdn/templates';
const PUBLIC_BASE = (config.APP_PUBLIC_BASE_URL ?? 'https://agent.yury-eremin.ru').replace(/\/$/, '');

interface SyncResult {
  voice: 'ye' | 'rz';
  carousel: string;
  synced: number;
  errors: number;
}

function naturalSort(a: GDriveFileMeta, b: GDriveFileMeta): number {
  const an = parseInt(a.name.match(/\d+/)?.[0] ?? '0', 10);
  const bn = parseInt(b.name.match(/\d+/)?.[0] ?? '0', 10);
  if (an !== bn) return an - bn;
  return a.name.localeCompare(b.name);
}

function extFromMime(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  return 'bin';
}

async function syncOneCarousel(
  pool: Pool,
  voice: 'ye' | 'rz',
  carouselName: string,
  folderId: string,
): Promise<SyncResult> {
  const items = (await listFolderFiles(folderId))
    .filter((f) => f.mimeType.startsWith('image/'))
    .sort(naturalSort);

  if (items.length === 0) {
    log.warn({ voice, carouselName }, 'template-sync: empty folder');
    return { voice, carousel: carouselName, synced: 0, errors: 0 };
  }

  const localDir = path.join(TEMPLATES_DIR, voice, carouselName);
  await mkdir(localDir, { recursive: true });

  let synced = 0;
  let errors = 0;

  for (let i = 0; i < items.length; i++) {
    const f = items[i]!;
    const slideNumber = i + 1;
    const ext = extFromMime(f.mimeType);
    const fname = `slide-${String(slideNumber).padStart(2, '0')}.${ext}`;
    const localPath = path.join(localDir, fname);
    const publicUrl = `${PUBLIC_BASE}/cdn/templates/${voice}/${encodeURIComponent(carouselName)}/${fname}`;

    try {
      const buf = await downloadFile(f.id);
      await writeFile(localPath, buf);
      await pool.query(
        `INSERT INTO carousel_template_slides
           (voice, carousel_name, slide_number, drive_file_id, drive_filename,
            local_path, public_url, bytes, mime_type, synced_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (voice, carousel_name, slide_number) DO UPDATE
           SET drive_file_id = EXCLUDED.drive_file_id,
               drive_filename = EXCLUDED.drive_filename,
               local_path = EXCLUDED.local_path,
               public_url = EXCLUDED.public_url,
               bytes = EXCLUDED.bytes,
               mime_type = EXCLUDED.mime_type,
               synced_at = NOW()`,
        [voice, carouselName, slideNumber, f.id, f.name, localPath, publicUrl, buf.length, f.mimeType],
      );
      synced += 1;
      log.info(
        { voice, carouselName, slideNumber, bytes: buf.length, publicUrl },
        'template-sync: slide saved',
      );
    } catch (err) {
      errors += 1;
      log.warn(
        { voice, carouselName, slideNumber, fileId: f.id, err: (err as Error).message },
        'template-sync: slide failed',
      );
    }
  }

  return { voice, carousel: carouselName, synced, errors };
}

/** Главная функция: проходит по 04-carousel-templates-ye/ + 05-carousel-templates-rz/. */
export async function syncAllTemplates(pool: Pool): Promise<SyncResult[]> {
  const rootId = config.GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID;
  if (!rootId) throw new Error('GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID not set');

  const results: SyncResult[] = [];
  for (const [voice, parentName] of [
    ['ye', '04-carousel-templates-ye'],
    ['rz', '05-carousel-templates-rz'],
  ] as const) {
    const parentId = await getFolderIdByName(rootId, parentName);
    if (!parentId) {
      log.warn({ parentName }, 'template-sync: parent folder not found');
      continue;
    }
    const subItems = await listFolderFiles(parentId);
    const folders = subItems.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
    log.info({ voice, parentName, subFolders: folders.length }, 'template-sync: starting voice');
    for (const folder of folders) {
      const r = await syncOneCarousel(pool, voice, folder.name, folder.id);
      results.push(r);
    }
  }

  // Total
  const total = results.reduce((a, r) => a + r.synced, 0);
  const errors = results.reduce((a, r) => a + r.errors, 0);
  log.info({ total, errors, carousels: results.length }, 'template-sync: ALL DONE');
  return results;
}
