import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Invariant qui rend le mode TRANSACTION du pooler SÛR pour mba (item 4.3) : le pool applicatif ne doit dépendre
 * d'AUCUN état de session Postgres. Un pooler en mode transaction réassigne le backend entre transactions, donc
 * un `SET search_path` (ou tout `SET SESSION`) posé sur la connexion ne tient pas -> tables introuvables / mauvais
 * schéma silencieux. mba est immunisé PARCE QUE ses tables sont dans public par défaut et le seul accès cross-schéma
 * (mmhs) est TOUJOURS qualifié (`mmhs.tenant_portals`). Ce test verrouille ça : si quelqu'un introduit un
 * `search_path`/`SET SESSION` dans le code DB applicatif, il casse ici et doit reconsidérer la sûreté transaction.
 */

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Tous les fichiers de code DB applicatif : les stores (*.pg.ts) + le pool. pg-boss est EXCLU (il vit sur la
 *  connexion session DATABASE_URL, pas sur ce pool). */
function appDbFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) appDbFiles(full, acc);
    else if (e.name.endsWith('.pg.ts')) acc.push(full);
  }
  return acc;
}

describe('invariant transaction-mode : le pool applicatif ne dépend d\'aucun état de session', () => {
  const files = [...appDbFiles(srcDir), join(srcDir, 'db', 'pool.ts')];

  it('collecte bien les stores applicatifs (garde-fou : le walk trouve des fichiers)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('aucun SET search_path / SET SESSION dans le code DB applicatif', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(/set\s+search_path/i.test(src), `${f} : SET search_path interdit (casse en transaction mode)`).toBe(false);
      expect(/set\s+session\b/i.test(src), `${f} : SET SESSION interdit (état de session)`).toBe(false);
    }
  });
});
