import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgStatsStore } from '../src/stats/store.pg';
import { ORIGINE_EFFECTIVE_SQL } from '../src/inbox/origine';

/**
 * LES MESSAGES ÉCRITS PAR L'AGENT DE META (Accueil et MBA > Paramètres, Julien, 2026-09-25), côté store.
 *
 * Un faux pool ne prouve pas le SQL : il prouve ce que le store ENVOIE (le filtre d'espace, le sens, l'origine,
 * l'absence de fenêtre) et ce qu'il fait de la ligne rendue. La sémantique (les réponses du client, l'équipe et
 * les campagnes écartées, fils de test, autre espace, historique `type = 'mba'`) est tenue par
 * `tests/integration/mba-messages.integration.test.ts`, sur un vrai Postgres, en CI.
 */
function fauxPool(n: string | null) {
  const appels: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      appels.push({ sql, params });
      return { rows: n === null ? [] : [{ n }] };
    },
  } as unknown as Pool;
  return { pool, appels };
}

/** Le SQL sans ses retours à la ligne ni ses espaces multiples : on lit des clauses, pas une mise en page. */
const plat = (sql: string): string => sql.replace(/\s+/g, ' ');

describe('PgStatsStore.messagesEcritsParMba', () => {
  it('🔴 la requête est filtrée par l espace, en paramètre $1, hors fils de test, et c est son SEUL paramètre', async () => {
    const { pool, appels } = fauxPool('0');
    await new PgStatsStore(pool).messagesEcritsParMba('espace-a');
    expect(appels).toHaveLength(1);
    const sql = plat(appels[0]!.sql);
    // `conversation_messages` ne porte pas l'espace : sans ce filtre sur le FIL, le chiffre compterait tous les
    // clients de la plateforme (la RLS est contournée en production).
    expect(sql).toContain('c.tenant_id = $1');
    expect(sql).toContain('not c.is_test');
    expect(appels[0]!.params).toEqual(['espace-a']);
  });

  it('🔴 seuls les SORTANTS dont l origine EFFECTIVE est `mba` : le fragment partagé, pas une recopie', async () => {
    const { pool, appels } = fauxPool('0');
    await new PgStatsStore(pool).messagesEcritsParMba('espace-a');
    const sql = plat(appels[0]!.sql);
    // `direction = 'out'` est aussi le prédicat de l'index partiel `conversation_messages_origin_idx` (0099).
    expect(sql).toContain("m.direction = 'out'");
    expect(sql).toContain(`${plat(ORIGINE_EFFECTIVE_SQL)} = 'mba'`);
    // Un `m.origin = 'mba'` écrit à la main perdrait l'historique marqué `type = 'mba'`.
    expect(sql).not.toMatch(/m\.origin = 'mba'/);
  });

  it('🔴 aucune borne de date : c est le total, pas 30 jours', async () => {
    const { pool, appels } = fauxPool('0');
    await new PgStatsStore(pool).messagesEcritsParMba('espace-a');
    const sql = plat(appels[0]!.sql);
    expect(sql).not.toMatch(/make_interval|interval '|now\(\)/);
    // Et plus de sous-select « conversations tenues » : on ne compte plus le fil entier.
    expect(sql).not.toMatch(/\bin \(/);
  });

  it('rend le compte en nombre', async () => {
    expect(await new PgStatsStore(fauxPool('1412').pool).messagesEcritsParMba('espace-a')).toBe(1412);
  });
});
