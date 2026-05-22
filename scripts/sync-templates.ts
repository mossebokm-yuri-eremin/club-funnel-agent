import { syncAllTemplates } from '../src/services/template-sync.js';
import { pool, closePool } from '../src/db/client.js';

(async () => {
  console.log('=== template-sync started ===');
  const r = await syncAllTemplates(pool);
  console.log('=== template-sync done ===');
  console.log(JSON.stringify(r, null, 2));
})().catch((e) => {
  console.error('FAIL:', (e as Error).message);
  process.exitCode = 1;
}).finally(() => closePool());
