import { describe, it, expect } from 'vitest';
import { listMigrations } from '../src/db/migrate.js';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('migration runner: file discovery', () => {
  it('listMigrations возвращает 001 и 002 в правильном порядке', async () => {
    const files = await listMigrations(path.join(ROOT, 'migrations'));
    const names = files.map((f) => f.filename);
    expect(names).toContain('001_initial.sql');
    expect(names).toContain('002_seed_voices.sql');
    // Лексикографическая сортировка
    expect(names.indexOf('001_initial.sql')).toBeLessThan(names.indexOf('002_seed_voices.sql'));
  });

  it('версия — basename без .sql', async () => {
    const files = await listMigrations(path.join(ROOT, 'migrations'));
    const v = files.find((f) => f.filename === '001_initial.sql');
    expect(v?.version).toBe('001_initial');
  });
});
