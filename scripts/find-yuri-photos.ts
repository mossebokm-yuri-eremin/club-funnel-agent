import { listFolderFiles, getFolderIdByName } from '../src/integrations/gdrive.js';
import { config } from '../src/config.js';

(async () => {
  const rootId = config.GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID;
  if (!rootId) throw new Error('GDRIVE_CAROUSEL_TEMPLATES_FOLDER_ID not set');
  console.log('Root folder:', rootId);
  const top = await listFolderFiles(rootId);
  console.log('=== TOP LEVEL ===');
  for (const f of top) {
    console.log('  ' + f.mimeType + ' ' + f.name + ' (' + f.id + ')');
  }
  // Поиск подпапки с фото Юрия
  for (const candidate of ['01-yuri-photos', '02-viktoriya-photos', '11-cases-data']) {
    const subId = await getFolderIdByName(rootId, candidate);
    if (!subId) {
      console.log('NOT FOUND: ' + candidate);
      continue;
    }
    console.log('=== ' + candidate + ' (id=' + subId + ') ===');
    const items = await listFolderFiles(subId);
    for (const f of items.slice(0, 30)) {
      console.log('  ' + f.mimeType + '  ' + f.name + '  ' + f.id);
    }
    if (items.length > 30) console.log('  ... and ' + (items.length - 30) + ' more');
  }
})().catch(e => { console.error(e.message); process.exit(1); });
