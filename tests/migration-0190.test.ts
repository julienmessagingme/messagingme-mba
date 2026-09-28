import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * 0190 : les traductions d'un jour font une ligne du journal de crédit. Elle passe AVANT le déploiement : l'ancien
 * code l'ignore, elle doit n'être qu'ADDITIVE (une colonne nullable sans défaut, un index).
 *
 * 🔴 L'index unique partiel est un CONTRAT avec une requête précise, l'upsert de `debiterTraduction` : si son
 * prédicat et celui de la clause `on conflict` divergent, Postgres ne trouve plus d'index à inférer et chaque
 * traduction échoue à se débiter, sans qu'aucun test unitaire ne le voie. Les deux textes sont donc comparés ici.
 */
const sql = readFileSync(new URL('../db/migrations/0190_credit_traduction_jour.sql', import.meta.url), 'utf8');
const code = sql.split(/\r?\n/).filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ').trim();
const store = readFileSync(new URL('../src/agent/credits.pg.ts', import.meta.url), 'utf8').replace(/\s+/g, ' ');

describe('migration 0190', () => {
  it('une colonne date, nullable, SANS défaut, puis l’index unique partiel', () => {
    expect(code).toBe(
      'alter table agent_credit_mouvements add column if not exists jour date; '
      + 'create unique index if not exists agent_credit_mouvements_traduction_jour_uidx '
      + "on agent_credit_mouvements (tenant_id, jour) where raison = 'traduction';",
    );
  });

  it('🔴 la clause on conflict du débit reprend EXACTEMENT les colonnes et le prédicat de l’index', () => {
    // Dérivé de la migration, pas recopié : c'est l'index RÉEL que la clause doit désigner.
    const index = /on agent_credit_mouvements (\([^)]*\) where [^;]+);/.exec(code);
    expect(index).not.toBeNull();
    expect(store).toContain(`on conflict ${index![1]} do update`);
  });

  it('⚠️ transactionnelle et sans accent grave dans le SQL', () => {
    expect(sql).not.toMatch(/--\s*migrate:\s*no-transaction/);
    expect(sql).not.toContain('`');
  });
});
