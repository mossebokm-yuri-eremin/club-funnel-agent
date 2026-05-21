// Что реально лежит в эталонных папках GDrive.
import { listFolderFiles, getFolderIdByName } from '../src/integrations/gdrive.js';

const ROOT = process.env.GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID!;
const NAMES = ['04-carousel-templates-ye', '01-yuri-photos', '08-yuri-past-posts'];

(async () => {
  console.log('=== ROOT folder ===');
  const root = await listFolderFiles(ROOT);
  for (const f of root) console.log(`  ${f.mimeType.padEnd(40)} ${f.name}`);

  for (const subName of NAMES) {
    console.log(`\n=== ${subName} ===`);
    const subId = await getFolderIdByName(ROOT, subName);
    if (!subId) { console.log('  NOT FOUND'); continue; }
    console.log(`  folderId=${subId}`);
    const items = await listFolderFiles(subId);
    console.log(`  items=${items.length}`);
    for (const f of items.slice(0, 20)) {
      console.log(`    ${f.mimeType.padEnd(40)} ${f.name}`);
    }
  }

  // и внутрь carousel-03-money тоже
  console.log('\n=== 04-carousel-templates-ye/carousel-03-money ===');
  const yeFolderId = await getFolderIdByName(ROOT, '04-carousel-templates-ye');
  if (yeFolderId) {
    const mFolderId = await getFolderIdByName(yeFolderId, 'carousel-03-money');
    if (mFolderId) {
      const items = await listFolderFiles(mFolderId);
      console.log(`  folderId=${mFolderId} items=${items.length}`);
      for (const f of items.slice(0, 20)) {
        console.log(`    ${f.mimeType.padEnd(40)} ${f.name}`);
      }
    } else {
      console.log('  carousel-03-money NOT FOUND');
    }
  }
  process.exit(0);
})().catch((e) => { console.error('ERR:', (e as Error).message); process.exit(1); });
