import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { PgAbonnementsNumeroStore } from '../src/stripe/abonnements.pg';

/**
 * L'ENREGISTREMENT D'UN ABONNEMENT DU NUMÉRO, sur une base simulée qui dit ce que la contrainte aurait dit (jaunes 3 et 4
 * de la relecture de la livraison B, lot 3c). La vérité en base est tenue par
 * `tests/integration/abonnements-numero.integration.test.ts`, jouée en CI.
 */
const T1 = '5f0c1e2a-8b7d-4c3e-9a1f-2d6b7e8c9f01';
const LIGNE_NUMERO = {
  id: 'n1', numero: '441235619343', didww_did_id: 'd1', statut: 'attribue', tenant_id: T1, attribue_le: new Date(), cree_le: new Date(),
};
const A = { tenantId: T1, abonnementId: 'sub_1', livemode: true, periodeFin: null };

function fausseBase(o: { statut?: 'actif' | 'resilie'; conflits?: number; ligneExiste?: boolean } = {}) {
  let conflits = o.conflits ?? 0;
  const requetes: string[] = [];
  const query = async (sql: string) => {
    requetes.push(sql);
    if (/insert into abonnements_numero/i.test(sql)) {
      if (conflits > 0) {
        conflits -= 1;
        throw Object.assign(new Error('violation'), { code: '23505', constraint: 'abonnements_numero_un_par_espace' });
      }
      return { rows: [{ statut: o.statut ?? 'actif', tenant_id: T1 }], rowCount: 1 };
    }
    if (/^\s*update numeros_fournis/i.test(sql)) return { rows: [LIGNE_NUMERO], rowCount: 1 };
    if (/from numeros_fournis/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/from abonnements_numero/i.test(sql)) return o.ligneExiste ? { rows: [{ existe: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
  return { pool, requetes };
}

describe('PgAbonnementsNumeroStore.enregistrer', () => {
  it('le cas ordinaire : l’abonnement et son numéro, ensemble', async () => {
    const b = fausseBase();
    expect(await new PgAbonnementsNumeroStore(b.pool).enregistrer(A)).toEqual({ etat: 'enregistre', numero: '441235619343' });
  });

  it('🟡 un événement rejoué pour un abonnement RÉSILIÉ : `resilie`, et aucun numéro attribué (pas de fausse « réserve vide »)', async () => {
    const b = fausseBase({ statut: 'resilie' });
    expect(await new PgAbonnementsNumeroStore(b.pool).enregistrer(A)).toEqual({ etat: 'resilie' });
    expect(b.requetes.some((q) => /update numeros_fournis/i.test(q))).toBe(false);
  });

  it('🟡 la course session et facture : le conflit vient de l’index d’espace, mais la ligne de CET abonnement existe : on réessaie', async () => {
    const b = fausseBase({ conflits: 1, ligneExiste: true });
    expect(await new PgAbonnementsNumeroStore(b.pool).enregistrer(A)).toEqual({ etat: 'enregistre', numero: '441235619343' });
  });

  it('🔴 un vrai doublon (un AUTRE abonnement vivant pour l’espace) reste un doublon', async () => {
    const b = fausseBase({ conflits: 1, ligneExiste: false });
    expect(await new PgAbonnementsNumeroStore(b.pool).enregistrer(A)).toEqual({ etat: 'doublon' });
  });

  it('un seul nouvel essai : un conflit qui revient rend `doublon`, sans boucler', async () => {
    const b = fausseBase({ conflits: 5, ligneExiste: true });
    expect(await new PgAbonnementsNumeroStore(b.pool).enregistrer(A)).toEqual({ etat: 'doublon' });
    expect(b.requetes.filter((q) => /insert into abonnements_numero/i.test(q))).toHaveLength(2);
  });
});
