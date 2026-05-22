// Сканирует новую папку GDrive: 1va-NJ5vLBOChCLbDSg5M-cp94SFSh79K
import { listFolderFiles, type GDriveFileMeta } from '../src/integrations/gdrive.js';

const FOLDER_ID = '1va-NJ5vLBOChCLbDSg5M-cp94SFSh79K';

async function walk(folderId: string, indent = ''): Promise<void> {
  let items: GDriveFileMeta[];
  try {
    items = await listFolderFiles(folderId);
  } catch (e) {
    console.log(`${indent}ERR: ${(e as Error).message.slice(0, 200)}`);
    return;
  }
  if (items.length === 0) {
    console.log(`${indent}(пусто)`);
    return;
  }
  for (const f of items) {
    const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
    const sz = f.size ? `  (${Math.round(parseInt(f.size, 10) / 1024)} KB)` : '';
    console.log(`${indent}${isFolder ? '📂' : '📄'} ${f.name}  [${f.mimeType.split('/').pop()}]${sz}`);
    if (isFolder && indent.length < 8) {
      await walk(f.id, indent + '  ');
    }
  }
}

(async () => {
  console.log(`=== ROOT folder ${FOLDER_ID} ===`);
  await walk(FOLDER_ID);
  process.exit(0);
})().catch((e) => { console.error('FAIL:', (e as Error).message); process.exit(1); });
