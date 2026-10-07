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

/**
 * L'ÉTAT DE L'ESPACE LIT LA COUVERTURE PAR LE PRO (lot 6, livraison B1, vigilance 4) : c'est la seule lecture de l'état,
 * celle du balayage qui suspend puis libère. La vérité en base est tenue par `tests/integration/offres.integration.test.ts`.
 */
describe('PgAbonnementsNumeroStore.etatDeLEspace, couvert par le Pro', () => {
  const JOUR = 24 * 3_600_000;
  const MAINTENANT = new Date('2026-11-20T12:00:00Z');
  function baseEtat(pro: { vivant: boolean | null; dernier_fini: Date | null }) {
    const query = async (sql: string) => {
      if (/from abonnements_offre/i.test(sql)) return { rows: [pro], rowCount: 1 };
      if (/from abonnements_numero/i.test(sql)) {
        return { rows: [{ stripe_subscription_id: 'sub_n', tenant_id: T1, livemode: true, statut: 'resilie', periode_fin: null,
          premier_echec_le: null, fin_prevue_le: null, fini_le: new Date(MAINTENANT.getTime() - 30 * JOUR), libere_le: null }], rowCount: 1 };
      }
      if (/as fourni/i.test(sql)) return { rows: [{ fourni: '441235619343', relie: '441235619343' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    return { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;
  }

  it('🔴 un Pro vivant : actif, sans fin ni libération, alors que l’abonnement du numéro est fini depuis 30 jours', async () => {
    const e = await new PgAbonnementsNumeroStore(baseEtat({ vivant: true, dernier_fini: null })).etatDeLEspace(T1, MAINTENANT);
    expect(e).toMatchObject({ etat: 'actif', finiLe: null, liberationLe: null, coupureLe: null });
  });

  it('🔴 un Pro fini il y a 2 jours : suspendu, libération 7 jours après la fin du PRO (et non dans le passé)', async () => {
    const finPro = new Date(MAINTENANT.getTime() - 2 * JOUR);
    const e = await new PgAbonnementsNumeroStore(baseEtat({ vivant: false, dernier_fini: finPro })).etatDeLEspace(T1, MAINTENANT);
    expect(e).toMatchObject({ etat: 'suspendu', finiLe: finPro, liberationLe: new Date(finPro.getTime() + 7 * JOUR) });
  });

  it('sans Pro : l’état du lot 4, inchangé', async () => {
    const e = await new PgAbonnementsNumeroStore(baseEtat({ vivant: null, dernier_fini: null })).etatDeLEspace(T1, MAINTENANT);
    expect(e).toMatchObject({ etat: 'suspendu', liberationLe: new Date(MAINTENANT.getTime() - 23 * JOUR) });
  });
});
