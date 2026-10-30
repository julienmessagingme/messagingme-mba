import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgConditionsCreditStore } from '../src/credit-whatsapp/conditions.pg';

/**
 * LES CONDITIONS D'UN ESPACE SUR LA LIGNE (plan du Crédit WhatsApp, tâche 8) : l'open bar et la commission négociée ne
 * valent qu'en Entreprise, lue par la seule définition de l'offre. Un faux pool rend la ligne que la base rendrait ; la
 * requête elle-même tourne sur la vraie base en CI (`tests/integration/offres.integration.test.ts`).
 */
type Ligne = { entreprise: boolean; open_bar: boolean | null; commission: number | null };

function monter(lignes: Record<string, Ligne>, globale = 5) {
  const requetes: string[] = [];
  let maintenant = 0;
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      requetes.push(sql);
      const l = lignes[String(params[0])];
      return { rows: l === undefined ? [] : [l] };
    },
  } as unknown as Pool;
  const store = new PgConditionsCreditStore(pool, { commission: async () => globale }, () => maintenant);
  return { store, requetes, avancer: (ms: number) => { maintenant += ms; } };
}

describe('les conditions du Crédit WhatsApp', () => {
  it('🔴 hors Entreprise, l’open bar et la commission négociée sont ignorés, même posés en base', async () => {
    const { store } = monter({ t1: { entreprise: false, open_bar: true, commission: 1 } });
    expect(await store.conditions('t1')).toEqual({ openBar: false, commissionPct: 5 });
  });

  it('une Entreprise prend son open bar et sa commission négociée ; sans commission négociée, la globale', async () => {
    const { store } = monter({
      t1: { entreprise: true, open_bar: true, commission: 3 },
      t2: { entreprise: true, open_bar: false, commission: null },
    });
    expect(await store.conditions('t1')).toEqual({ openBar: true, commissionPct: 3 });
    expect(await store.conditions('t2')).toEqual({ openBar: false, commissionPct: 5 });
    expect(await store.commissionMessagesPour('t1')).toBe(3);
  });

  it('une commission négociée à zéro reste zéro, pas la globale', async () => {
    const { store } = monter({ t1: { entreprise: true, open_bar: false, commission: 0 } });
    expect(await store.conditions('t1')).toEqual({ openBar: false, commissionPct: 0 });
  });

  it('un espace inconnu : ni open bar, la commission globale', async () => {
    const { store } = monter({});
    expect(await store.conditions('inconnu')).toEqual({ openBar: false, commissionPct: 5 });
  });

  it('🔴 l’offre se lit par sa seule définition, `offre_de_l_espace`, jamais par une colonne recopiée', async () => {
    const { store, requetes } = monter({ t1: { entreprise: true, open_bar: true, commission: null } });
    await store.conditions('t1');
    expect(requetes[0]).toMatch(/offre_de_l_espace\(\$1::uuid\) = 'entreprise'/);
    expect(requetes[0]).not.toMatch(/offre_entreprise/);
  });

  it('une lecture par espace toutes les cinq secondes au plus', async () => {
    const { store, requetes, avancer } = monter({ t1: { entreprise: true, open_bar: true, commission: null } });
    await store.conditions('t1');
    avancer(4_999);
    await store.conditions('t1');
    expect(requetes).toHaveLength(1);
    avancer(1);
    await store.conditions('t1');
    expect(requetes).toHaveLength(2);
  });
});
