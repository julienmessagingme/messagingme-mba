import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 0189 : archiver une publicité. Elle passe AVANT le déploiement : l'ancien code l'ignore, elle doit n'être
 * qu'ADDITIVE et nullable sans défaut (null = pas archivée, donc toutes les publicités existantes restent visibles).
 */
const sql = readFileSync(new URL('../db/migrations/0189_pubs_archivage.sql', import.meta.url), 'utf8');
const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ');

describe('migration 0189', () => {
  it('une colonne horodatée, nullable, SANS défaut', () => {
    expect(code.trim()).toBe('alter table publicites add column if not exists archivee_le timestamptz;');
  });

  it('⚠️ transactionnelle et sans accent grave dans le SQL', () => {
    expect(sql).not.toMatch(/--\s*migrate:\s*no-transaction/);
    expect(sql).not.toContain('`');
  });
});
