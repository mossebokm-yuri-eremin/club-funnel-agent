// Smoke: activate funnel for a real idea via MCP.
import { activateFunnelOnApprove } from '../src/services/funnel-activator.js';
import { pool, closePool } from '../src/db/client.js';

const IDEA_ID = process.argv[2];
const PKG_ID = process.argv[3];
if (!IDEA_ID || !PKG_ID) {
  console.error('usage: tsx test-funnel.ts <ideaId> <contentPackageId>');
  process.exit(1);
}

(async () => {
  console.log('[smoke] activating funnel for idea', IDEA_ID);
  const r = await activateFunnelOnApprove(pool, {
    ideaId: IDEA_ID,
    contentPackageId: PKG_ID,
  });
  console.log('[smoke] result:', JSON.stringify(r, null, 2));
})()
  .catch((e) => {
    console.error('FAIL:', (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
