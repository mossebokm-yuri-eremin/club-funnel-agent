import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './client.js';
import { log } from '../observability/logger.js';

const MIGRATION_FILE_RE = /^(\d{3,})_[a-z0-9_]+\.sql$/i;

export interface MigrationFile {
  version: string;
  filename: string;
  absPath: string;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

function defaultMigrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/db -> repo root
  return path.resolve(here, '..', '..', 'migrations');
}

export async function listMigrations(dir: string = defaultMigrationsDir()): Promise<MigrationFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = e.name.match(MIGRATION_FILE_RE);
    if (!m) continue;
    files.push({
      version: e.name.replace(/\.sql$/i, ''),
      filename: e.name,
      absPath: path.join(dir, e.name),
    });
  }
  files.sort((a, b) => a.filename.localeCompare(b.filename));
  return files;
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS _schema_migrations (
       version    TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
  );
}

async function appliedVersions(): Promise<Set<string>> {
  const r = await pool.query<{ version: string }>('SELECT version FROM _schema_migrations');
  return new Set(r.rows.map((row) => row.version));
}

export async function migrateUp(dir?: string): Promise<MigrateResult> {
  const files = await listMigrations(dir);
  await ensureMigrationsTable();
  const applied = await appliedVersions();

  const result: MigrateResult = { applied: [], skipped: [] };

  for (const f of files) {
    if (applied.has(f.version)) {
      log.info({ version: f.version }, 'migrate: already applied, skip');
      result.skipped.push(f.version);
      continue;
    }
    const sql = await readFile(f.absPath, 'utf8');
    log.info({ version: f.version, bytes: sql.length }, 'migrate: applying');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      // Migration files insert into _schema_migrations themselves; we add a
      // safety net here in case a future migration forgets to do so.
      await client.query(
        'INSERT INTO _schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [f.version],
      );
      await client.query('COMMIT');
      result.applied.push(f.version);
      log.info({ version: f.version }, 'migrate: applied');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      log.error({ err, version: f.version }, 'migrate: failed, rolled back');
      throw err;
    } finally {
      client.release();
    }
  }

  return result;
}

export async function migrateStatus(dir?: string): Promise<{
  files: MigrationFile[];
  applied: string[];
  pending: string[];
}> {
  const files = await listMigrations(dir);
  await ensureMigrationsTable();
  const applied = await appliedVersions();
  return {
    files,
    applied: files.map((f) => f.version).filter((v) => applied.has(v)),
    pending: files.map((f) => f.version).filter((v) => !applied.has(v)),
  };
}
