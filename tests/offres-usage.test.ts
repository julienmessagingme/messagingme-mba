import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgOffresStore } from '../src/offres/offre.pg';
import { ficheComptee } from '../src/crm/contact-store.pg';

/**
 * L'USAGE DE LA VUE DE L'OFFRE COMPTE LES CONTACTS COMME LA LIMITE LES COMPTE (décision de Julien du 2026-10-25) : ce que
 * voient la console et `get_plan`, et ce que lisent les courriels de franchissement. Sur un faux pool qui rend les deux
 * comptes : 100 fiches vivantes, dont 60 créées. Ce que la vraie base compte est dans
 * `tests/integration/offres.integration.test.ts`, en CI.
 */
function pool(offre: string) {
  const appels: string[] = [];
  const p = {
    query: async (sql: string) => {
      appels.push(sql);
      return { rows: [{ offre, toutes_origines: 100, creees: 60, automations: 2, membres: 1 }], rowCount: 1 };
    },
  };
  return { p: p as unknown as Pool, appels };
}

describe('🔴 l’usage des contacts suit l’offre (`contactsToutesOrigines`)', () => {
  it('en Free, toutes les fiches vivantes ; en Pro et en Entreprise, les fiches créées', async () => {
    expect(await new PgOffresStore(pool('base').p).usage('t1')).toEqual({ contacts: 100, automations: 2, membres: 1 });
    expect((await new PgOffresStore(pool('pro').p).usage('t1')).contacts).toBe(60);
    expect((await new PgOffresStore(pool('entreprise').p).usage('t1')).contacts).toBe(60);
  });

  it('une offre que le code ne connaît pas se lit comme la Base, comme `offreDe`', async () => {
    expect((await new PgOffresStore(pool('or').p).usage('t1')).contacts).toBe(100);
  });

  it('une seule requête : l’offre par la seule définition, les fiches par le prédicat des gardes du magasin des contacts', async () => {
    const { p, appels } = pool('base');
    await new PgOffresStore(p).usage('t1');
    expect(appels).toHaveLength(1);
    expect(appels[0]).toContain('offre_de_l_espace($1::uuid)');
    expect(appels[0]).toContain(ficheComptee('c', true));
    expect(appels[0]).toContain(ficheComptee('c', false));
  });
});
