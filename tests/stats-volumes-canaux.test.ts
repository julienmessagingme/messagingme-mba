import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgStatsStore } from '../src/stats/store.pg';

/**
 * LES VOLUMES PAR CANAL (cartes « Numéro WhatsApp » et « Canal RCS » de l'Accueil), côté store.
 *
 * Un faux pool ne prouve pas le SQL : il prouve ce que le store ENVOIE (le filtre d'espace, la fenêtre, les
 * paramètres) et ce qu'il fait des lignes rendues. La sémantique (fils de test, autre espace, fenêtre, modèles
 * comptés) est tenue par `tests/integration/volumes-canaux.integration.test.ts`, sur un vrai Postgres, en CI.
 */
function fauxPool(lignes: Array<{ canal: string; envoyes: string; recus: string }>) {
  const appels: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      appels.push({ sql, params });
      return { rows: lignes };
    },
  } as unknown as Pool;
  return { pool, appels };
}

/** Le SQL sans ses retours à la ligne ni ses espaces multiples : on lit des clauses, pas une mise en page. */
const plat = (sql: string): string => sql.replace(/\s+/g, ' ');

describe('PgStatsStore.volumesParCanal', () => {
  it('🔴 la requête est filtrée par l espace, en paramètre $1, et sur la fenêtre en $2', async () => {
    const { pool, appels } = fauxPool([]);
    await new PgStatsStore(pool).volumesParCanal('espace-a', 30);
    expect(appels).toHaveLength(1);
    const sql = plat(appels[0]!.sql);
    // `conversation_messages` ne porte pas l'espace : sans ce filtre sur le FIL, la carte compterait tous les
    // clients de la plateforme (la RLS est contournée en production).
    expect(sql).toContain('cv.tenant_id = $1');
    expect(sql).toContain('not cv.is_test');
    expect(sql).toContain('m.created_at > now() - make_interval(days => $2)');
    expect(appels[0]!.params).toEqual(['espace-a', 30]);
  });

  it('🔴 les modèles ne sont PAS écartés : la carte dit ce qui est passé par le numéro', async () => {
    const { pool, appels } = fauxPool([]);
    await new PgStatsStore(pool).volumesParCanal('espace-a', 30);
    // L'écart délibéré avec « Messages échangés » : un filtre `type ... 'template'` ferait lire « 3 envoyés »
    // à un espace qui vient d'envoyer une campagne de 5 000.
    expect(plat(appels[0]!.sql)).not.toMatch(/template/);
  });

  it('range les lignes par canal ; un canal sans ligne est un zéro MESURÉ ; un canal inconnu est ignoré', async () => {
    const { pool } = fauxPool([
      { canal: 'whatsapp', envoyes: '1234', recus: '567' },
      { canal: 'email', envoyes: '99', recus: '99' },
    ]);
    expect(await new PgStatsStore(pool).volumesParCanal('espace-a', 30)).toEqual({
      whatsapp: { envoyes: 1234, recus: 567 },
      rcs: { envoyes: 0, recus: 0 },
    });
  });
});
