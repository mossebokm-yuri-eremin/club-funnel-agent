// scripts/refresh-kb.ts — CLI обёртка над refreshKnowledgeEmbeddings.
// Запуск: cd /opt/club-funnel && sudo -u club -H npm run refresh:kb
//
// Использует config.ts (process.env уже загружен pm2/env_file), не пытается
// сам парсить /etc/club-funnel/.env. На VPS env-переменные подгружаются
// через pm2 ecosystem env_file.

import { refreshKnowledgeEmbeddings } from '../src/services/knowledge-loader.js';
import { pool, closePool } from '../src/db/client.js';
import { log } from '../src/observability/logger.js';

async function main(): Promise<void> {
  log.info({}, 'refresh-kb: started');
  const r = await refreshKnowledgeEmbeddings(pool);
  log.info(r, 'refresh-kb: done');
  console.log(JSON.stringify(r, null, 2));
}

main()
  .catch((err) => {
    log.error({ err: (err as Error).message }, 'refresh-kb: failed');
    console.error('FAIL:', (err as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
