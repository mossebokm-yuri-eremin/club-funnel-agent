import { migrateUp, migrateStatus } from '../src/db/migrate.js';
import { closePool } from '../src/db/client.js';
import { log } from '../src/observability/logger.js';

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'up';
  try {
    if (cmd === 'up') {
      const res = await migrateUp();
      log.info({ applied: res.applied, skipped: res.skipped }, 'migrate:up done');
    } else if (cmd === 'status') {
      const s = await migrateStatus();
      log.info(
        { total: s.files.length, applied: s.applied.length, pending: s.pending },
        'migrate:status',
      );
    } else if (cmd === 'down') {
      log.warn(
        'migrate:down is intentionally not supported — write a forward-only down migration instead',
      );
      process.exitCode = 1;
    } else {
      log.error({ cmd }, 'migrate: unknown command (expected up|status|down)');
      process.exitCode = 2;
    }
  } catch (err) {
    log.fatal({ err }, 'migrate: command failed');
    process.exitCode = 1;
  } finally {
    await closePool().catch(() => undefined);
  }
}

void main();
