import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgAbonnementsOffreStore } from '../src/offres/abonnements-offre.pg';

/**
 * LE MAGASIN DU PRO, sur une base simulée qui dit ce que la contrainte aurait dit (jaunes 1 et 11 de la relecture de B1,
 * lot 6). La vérité en base est tenue par `tests/integration/offres.integration.test.ts`, jouée en CI.
 */
const T1 = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';
const A = { tenantId: T1, abonnementId: 'sub_1', periodicite: 'mois' as const, livemode: true, periodeFin: null };

function fausseBase(o: { conflits?: number; ligneExiste?: boolean } = {}) {
  let conflits = o.conflits ?? 0;
  const requetes: string[] = [];
  const query = async (sql: string) => {
    requetes.push(sql);
    if (/insert into abonnements_offre/i.test(sql)) {
      if (conflits > 0) {
        conflits -= 1;
        throw Object.assign(new Error('violation'), { code: '23505', constraint: 'abonnements_offre_un_vivant_par_espace' });
      }
      return { rows: [{ tenant_id: T1, fini_le: null, nouveau: false }], rowCount: 1 };
    }
    if (/from abonnements_offre/i.test(sql)) return o.ligneExiste ? { rows: [{ existe: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  return { pool: { query } as unknown as Pool, requetes };
}

describe('PgAbonnementsOffreStore.enregistrer', () => {
  it('🟡 la course session et facture : le conflit vient de l’index d’espace, mais la ligne de CET abonnement existe : on réessaie', async () => {
    const b = fausseBase({ conflits: 1, ligneExiste: true });
    expect(await new PgAbonnementsOffreStore(b.pool).enregistrer(A)).toEqual({ etat: 'enregistre', tenantId: T1, nouveau: false });
  });

  it('🔴 un vrai doublon (un AUTRE Pro vivant pour l’espace) reste un doublon', async () => {
    const b = fausseBase({ conflits: 1, ligneExiste: false });
    expect(await new PgAbonnementsOffreStore(b.pool).enregistrer(A)).toEqual({ etat: 'doublon' });
  });

  it('un seul nouvel essai : un conflit qui revient rend `doublon`, sans boucler', async () => {
    const b = fausseBase({ conflits: 5, ligneExiste: true });
    expect(await new PgAbonnementsOffreStore(b.pool).enregistrer(A)).toEqual({ etat: 'doublon' });
    expect(b.requetes.filter((q) => /insert into abonnements_offre/i.test(q))).toHaveLength(2);
  });
});

describe('PgAbonnementsOffreStore.finir', () => {
  it('🟡 dit si c’est la PREMIÈRE fin : un rejeu de la fin ne doit pas réalerter', async () => {
    const requetes: string[] = [];
    const query = async (sql: string) => {
      requetes.push(sql);
      return { rows: [{
        stripe_subscription_id: 'sub_1', tenant_id: T1, periodicite: 'mois', livemode: true, statut: 'resilie', periode_fin: null,
        fin_prevue_le: null, fini_le: new Date('2026-11-01T00:00:00Z'), fin_raison: 'impaye', premiere_fin: false,
      }], rowCount: 1 };
    };
    const r = await new PgAbonnementsOffreStore({ query } as unknown as Pool).finir('sub_1', 'resiliation', new Date());
    expect(r).toMatchObject({ abonnementId: 'sub_1', finRaison: 'impaye', premiereFin: false });
    // La valeur vient de l'état AVANT l'écriture, verrouillé : sinon deux fins concurrentes se croiraient toutes deux premières.
    expect(requetes[0]).toMatch(/for update/);
    expect(requetes[0]).toMatch(/is null as premiere_fin/);
  });
});
