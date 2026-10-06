import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgAbonnementsNumeroStore } from '../../src/stripe/abonnements.pg';
import { PgNumerosFournisStore } from '../../src/otp/store.pg';

/**
 * L'ABONNEMENT DU NUMÉRO FOURNI (migration 0214, lot 3c livraison B), sur une vraie base.
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : l'abonnement et le numéro écrits ENSEMBLE, l'idempotence par l'abonnement
 * Stripe, l'unicité d'un abonnement vivant par espace, et la fin de période qui ne recule jamais.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const N1 = '449990000011';
const N2 = '449990000012';
const MARS = new Date('2026-11-06T09:00:00Z');
const AVRIL = new Date('2026-12-06T09:00:00Z');

describe.skipIf(!url)('l’abonnement du numéro fourni (0214)', () => {
  let pool: Pool;
  let abonnements: PgAbonnementsNumeroStore;
  let numeros: PgNumerosFournisStore;
  let t1 = '';
  let t2 = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    abonnements = new PgAbonnementsNumeroStore(pool);
    numeros = new PgNumerosFournisStore(pool);
    t1 = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-abonnement-1') returning id`)).rows[0]!.id;
    t2 = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-abonnement-2') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`delete from numeros_fournis where numero like '4499900000%'`);
    await pool.query('delete from tenants where id = any($1::uuid[])', [[t1, t2]]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('delete from abonnements_numero where tenant_id = any($1::uuid[])', [[t1, t2]]);
    await pool.query(`delete from numeros_fournis where numero like '4499900000%'`);
  });

  it('🔴 enregistrer : l’abonnement actif ET le numéro attribué, ensemble ; rejoué, ni second abonnement ni second numéro', async () => {
    await numeros.declarer(N1, 'did-itest-ab-1');
    await numeros.declarer(N2, 'did-itest-ab-2');
    expect(await abonnements.enregistrer({ tenantId: t1, abonnementId: 'sub_itest1', livemode: false, periodeFin: null }))
      .toEqual({ etat: 'enregistre', numero: N1 });
    expect(await abonnements.enregistrer({ tenantId: t1, abonnementId: 'sub_itest1', livemode: false, periodeFin: MARS }))
      .toEqual({ etat: 'enregistre', numero: N1 });
    expect(await abonnements.deLEspace(t1)).toMatchObject({ abonnementId: 'sub_itest1', statut: 'actif', periodeFin: MARS });
    expect(await numeros.compterLibres()).toBe(1);
  });

  it('🔴 la réserve vide : l’abonnement est gardé sans numéro, et l’espace attend', async () => {
    expect(await abonnements.enregistrer({ tenantId: t1, abonnementId: 'sub_itest2', livemode: false, periodeFin: null }))
      .toEqual({ etat: 'enregistre', numero: null });
    expect(await abonnements.deLEspace(t1)).toMatchObject({ statut: 'actif' });
    expect(await abonnements.enAttenteDeNumero()).toContain(t1);
    await numeros.declarer(N1, 'did-itest-ab-1');
    await numeros.attribuer(t1);
    expect(await abonnements.enAttenteDeNumero()).not.toContain(t1);
  });

  it('🔴 un second abonnement vivant pour le même espace : doublon, rien n’est écrit', async () => {
    await numeros.declarer(N1, 'did-itest-ab-1');
    await abonnements.enregistrer({ tenantId: t1, abonnementId: 'sub_itest3', livemode: false, periodeFin: null });
    expect(await abonnements.enregistrer({ tenantId: t1, abonnementId: 'sub_itest4', livemode: false, periodeFin: null })).toEqual({ etat: 'doublon' });
    expect((await pool.query('select 1 from abonnements_numero where stripe_subscription_id = $1', ['sub_itest4'])).rowCount).toBe(0);
  });

  it('les statuts : la fin de période ne recule pas, `resilie` est terminal, un inconnu rend null', async () => {
    await abonnements.enregistrer({ tenantId: t2, abonnementId: 'sub_itest5', livemode: false, periodeFin: AVRIL });
    expect(await abonnements.majStatut('sub_itest5', 'en_retard', MARS)).toMatchObject({ statut: 'en_retard', periodeFin: AVRIL });
    expect(await abonnements.majStatut('sub_itest5', 'resilie', null)).toMatchObject({ statut: 'resilie' });
    // Un paiement arrivé en retard ne ressuscite pas un abonnement résilié, ni ne lui attribue un numéro.
    expect(await abonnements.majStatut('sub_itest5', 'actif', null)).toMatchObject({ statut: 'resilie' });
    await numeros.declarer(N1, 'did-itest-ab-1');
    // Rejoué pour un abonnement résilié : `resilie`, rien d'attribué, et donc pas de fausse alerte « réserve vide ».
    expect(await abonnements.enregistrer({ tenantId: t2, abonnementId: 'sub_itest5', livemode: false, periodeFin: null }))
      .toEqual({ etat: 'resilie' });
    expect(await numeros.parNumero(N1)).toMatchObject({ statut: 'libre', tenantId: null });
    expect(await abonnements.majStatut('sub_inconnu', 'actif', null)).toBeNull();
    // Résilié, l'espace peut se réabonner.
    expect(await abonnements.enregistrer({ tenantId: t2, abonnementId: 'sub_itest6', livemode: false, periodeFin: null }))
      .toEqual({ etat: 'enregistre', numero: N1 });
    expect(await abonnements.deLEspace(t2)).toMatchObject({ abonnementId: 'sub_itest6', statut: 'actif' });
  });

  it('🔴 les CHECK : un identifiant qui n’est pas un abonnement Stripe, un statut inconnu', async () => {
    await expect(pool.query(`insert into abonnements_numero (stripe_subscription_id, tenant_id, livemode) values ('cs_x', $1, false)`, [t1]))
      .rejects.toMatchObject({ code: '23514' });
    await expect(pool.query(`insert into abonnements_numero (stripe_subscription_id, tenant_id, livemode, statut) values ('sub_y', $1, false, 'gratuit')`, [t1]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('un espace supprimé emporte ses abonnements (cascade)', async () => {
    const t3 = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-abonnement-3') returning id`)).rows[0]!.id;
    await abonnements.enregistrer({ tenantId: t3, abonnementId: 'sub_itest7', livemode: false, periodeFin: null });
    await pool.query('delete from tenants where id = $1', [t3]);
    expect((await pool.query('select 1 from abonnements_numero where stripe_subscription_id = $1', ['sub_itest7'])).rowCount).toBe(0);
  });
});

/**
 * 🔴 LE LOT 4 (migration 0215) : les dates qui font l'état. Le premier échec d'une série se garde une fois, un paiement
 * l'efface ; la fin effective se date ; la résiliation programmée se pose et se retire ; un avis ne part qu'une fois ;
 * et l'état d'un espace qui se réabonne redevient actif.
 */
describe.skipIf(!url)('l’abonnement du numéro fourni : les dates du lot 4 (0215)', () => {
  let pool: Pool;
  let abonnements: PgAbonnementsNumeroStore;
  let numeros: PgNumerosFournisStore;
  let t = '';
  const N3 = '449990000013';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    abonnements = new PgAbonnementsNumeroStore(pool);
    numeros = new PgNumerosFournisStore(pool);
    t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-abonnement-lot4') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`delete from numeros_fournis where numero = $1`, [N3]);
    await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('delete from abonnements_numero where tenant_id = $1', [t]);
    await pool.query(`delete from numeros_fournis where numero = $1`, [N3]);
    await numeros.declarer(N3, 'did-itest-lot4');
  });

  it('🔴 le premier échec se garde une fois ; un paiement l’efface ; l’espace est en retard puis actif', async () => {
    await abonnements.enregistrer({ tenantId: t, abonnementId: 'sub_lot4a', livemode: false, periodeFin: null });
    const a = await abonnements.majStatut('sub_lot4a', 'en_retard', null);
    expect(a?.premierEchecLe).toBeInstanceOf(Date);
    const b = await abonnements.majStatut('sub_lot4a', 'en_retard', null);
    expect(b?.premierEchecLe?.getTime()).toBe(a?.premierEchecLe?.getTime());
    expect(await abonnements.etatDeLEspace(t)).toMatchObject({ abonnementId: 'sub_lot4a', etat: 'en_retard' });
    // Le balayage surveille l'espace tant que l'échec court, plus après le paiement.
    expect(await abonnements.aSurveiller()).toContain(t);
    expect(await abonnements.majStatut('sub_lot4a', 'actif', null)).toMatchObject({ statut: 'actif', premierEchecLe: null });
    expect(await abonnements.aSurveiller()).not.toContain(t);
    expect(await abonnements.etatDeLEspace(t)).toMatchObject({ etat: 'actif' });
  });

  it('🔴 un échec rejoué APRÈS le paiement de la même facture ne repose rien ; l’échec d’une période suivante, si', async () => {
    // Stripe ne garantit pas l'ordre : sans cette garde, l'échec rejoué reposait `en_retard` et une date de premier
    // échec, et sept jours plus tard les envois d'un client qui a payé étaient coupés.
    const avril = new Date('2026-04-01T00:00:00Z');
    const mai = new Date('2026-05-01T00:00:00Z');
    await abonnements.enregistrer({ tenantId: t, abonnementId: 'sub_lot4e', livemode: false, periodeFin: null });
    expect(await abonnements.majStatut('sub_lot4e', 'actif', avril)).toMatchObject({ statut: 'actif', periodeFin: avril });
    expect(await abonnements.majStatut('sub_lot4e', 'en_retard', null, avril)).toBeNull();
    expect(await abonnements.etatDeLEspace(t)).toMatchObject({ abonnementId: 'sub_lot4e', etat: 'actif' });
    expect(await abonnements.aSurveiller()).not.toContain(t);
    // Le renouvellement suivant (période jusqu'à mai) échoue : celui-là compte.
    expect(await abonnements.majStatut('sub_lot4e', 'en_retard', null, mai)).toMatchObject({ statut: 'en_retard', periodeFin: avril });
    expect(await abonnements.etatDeLEspace(t)).toMatchObject({ etat: 'en_retard' });
  });

  it('🔴 la fin se date une fois et suspend ; la libération est prévue 7 jours après', async () => {
    await abonnements.enregistrer({ tenantId: t, abonnementId: 'sub_lot4b', livemode: false, periodeFin: null });
    const fin = await abonnements.majStatut('sub_lot4b', 'resilie', null);
    expect(fin?.finiLe).toBeInstanceOf(Date);
    const encore = await abonnements.majStatut('sub_lot4b', 'resilie', null);
    expect(encore?.finiLe?.getTime()).toBe(fin?.finiLe?.getTime());
    const e = await abonnements.etatDeLEspace(t);
    expect(e).toMatchObject({ etat: 'suspendu' });
    expect(e?.liberationLe?.getTime()).toBe(fin!.finiLe!.getTime() + 7 * 24 * 3_600_000);
  });

  it('la résiliation programmée se pose, se retire, et ne ressuscite pas un abonnement fini', async () => {
    await abonnements.enregistrer({ tenantId: t, abonnementId: 'sub_lot4c', livemode: false, periodeFin: null });
    const date = new Date('2026-11-06T14:51:15Z');
    expect(await abonnements.noterFinPrevue('sub_lot4c', date)).toBe(true);
    expect(await abonnements.etatDeLEspace(t)).toMatchObject({ etat: 'fin_prevue', finPrevueLe: date });
    await abonnements.noterFinPrevue('sub_lot4c', null);
    expect(await abonnements.etatDeLEspace(t)).toMatchObject({ etat: 'actif', finPrevueLe: null });
    await abonnements.majStatut('sub_lot4c', 'resilie', null);
    await abonnements.noterFinPrevue('sub_lot4c', date);
    expect(await abonnements.etatDeLEspace(t)).toMatchObject({ etat: 'suspendu' });
    expect(await abonnements.noterFinPrevue('sub_inconnu', date)).toBe(false);
  });

  it('🔴 un nouvel abonnement vivant efface la suspension de l’ancien (réabonnement)', async () => {
    await abonnements.enregistrer({ tenantId: t, abonnementId: 'sub_lot4d', livemode: false, periodeFin: null });
    await abonnements.majStatut('sub_lot4d', 'resilie', null);
    expect(await abonnements.etatDeLEspace(t)).toMatchObject({ etat: 'suspendu' });
    expect(await abonnements.enregistrer({ tenantId: t, abonnementId: 'sub_lot4e', livemode: false, periodeFin: null }))
      .toEqual({ etat: 'enregistre', numero: N3 });
    expect(await abonnements.etatDeLEspace(t)).toMatchObject({ abonnementId: 'sub_lot4e', etat: 'actif' });
  });

  it('un avis ne part qu’une fois par abonnement ; un espace sans abonnement n’a pas d’état', async () => {
    await abonnements.enregistrer({ tenantId: t, abonnementId: 'sub_lot4f', livemode: false, periodeFin: null });
    expect(await abonnements.noterAvis('sub_lot4f', 'suspension_telegram')).toBe(true);
    expect(await abonnements.noterAvis('sub_lot4f', 'suspension_telegram')).toBe(false);
    expect(await abonnements.noterAvis('sub_lot4f', 'suspension_mail')).toBe(true);
    await expect(pool.query(`insert into abonnements_numero_avis (stripe_subscription_id, avis) values ('sub_lot4f', 'inconnu')`))
      .rejects.toMatchObject({ code: '23514' });
    await pool.query('delete from abonnements_numero where tenant_id = $1', [t]);
    expect(await abonnements.etatDeLEspace(t)).toBeNull();
  });

  it('🔴 un paiement oublie les avis de suspension : une seconde suspension prévient de nouveau (livraison B, jaune 6)', async () => {
    await abonnements.enregistrer({ tenantId: t, abonnementId: 'sub_lot4g', livemode: false, periodeFin: null });
    await abonnements.majStatut('sub_lot4g', 'en_retard', null);
    expect(await abonnements.noterAvis('sub_lot4g', 'suspension_telegram')).toBe(true);
    expect(await abonnements.noterAvis('sub_lot4g', 'suspension_mail')).toBe(true);
    expect(await abonnements.noterAvis('sub_lot4g', 'rappel_liberation_mail')).toBe(true);
    expect(await abonnements.avisDejaParti('sub_lot4g', 'suspension_telegram')).toBe(true);
    await abonnements.majStatut('sub_lot4g', 'actif', null);
    expect(await abonnements.avisDejaParti('sub_lot4g', 'suspension_telegram')).toBe(false);
    expect(await abonnements.avisDejaParti('sub_lot4g', 'suspension_mail')).toBe(false);
    // Les autres avis ne bougent pas, et un abonnement fini (qui ne redevient jamais actif) garde les siens.
    expect(await abonnements.avisDejaParti('sub_lot4g', 'rappel_liberation_mail')).toBe(true);
    await abonnements.noterAvis('sub_lot4g', 'suspension_telegram');
    await abonnements.majStatut('sub_lot4g', 'resilie', null);
    await abonnements.majStatut('sub_lot4g', 'actif', null);
    expect(await abonnements.avisDejaParti('sub_lot4g', 'suspension_telegram')).toBe(true);
  });

  it('🔴 un abonné dont la fin est programmée (« Abandonner ») n’attend plus de numéro', async () => {
    await abonnements.enregistrer({ tenantId: t, abonnementId: 'sub_lot4k', livemode: false, periodeFin: null });
    await numeros.rendre(t);
    expect(await abonnements.enAttenteDeNumero()).toContain(t);
    await abonnements.noterFinPrevue('sub_lot4k', new Date('2026-11-06T14:51:15Z'));
    expect(await abonnements.enAttenteDeNumero()).not.toContain(t);
  });

  it('🔴 la surveillance suit l’abonnement COURANT : un espace réabonné ne l’est plus pour sa vieille ligne', async () => {
    await abonnements.enregistrer({ tenantId: t, abonnementId: 'sub_lot4h', livemode: false, periodeFin: null });
    await abonnements.majStatut('sub_lot4h', 'resilie', null);
    expect(await abonnements.aSurveiller()).toContain(t);
    await abonnements.enregistrer({ tenantId: t, abonnementId: 'sub_lot4i', livemode: false, periodeFin: null });
    expect(await abonnements.aSurveiller()).not.toContain(t);
  });

  it('🔴 un AUTRE numéro relié (le sien) : jamais « suspendu » ; des chiffres inconnus comptent pour le numéro fourni', async () => {
    const waba = `itest-lot4-waba-${t.slice(0, 8)}`;
    const pn = `itest-lot4-pn-${t.slice(0, 8)}`;
    await pool.query(`insert into waba (id, tenant_id, name) values ($1, $2, 'itest')`, [waba, t]);
    try {
      await abonnements.enregistrer({ tenantId: t, abonnementId: 'sub_lot4j', livemode: false, periodeFin: null });
      await abonnements.majStatut('sub_lot4j', 'resilie', null);
      await pool.query(
        `insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, status) values ($1, $2, $3, '+33 6 12 34 56 78', 'CONNECTED')`,
        [pn, t, waba],
      );
      expect(await abonnements.etatDeLEspace(t)).toMatchObject({ etat: 'libere' });
      await pool.query(`update phone_numbers set display_phone_number = null where id = $1`, [pn]);
      expect(await abonnements.etatDeLEspace(t)).toMatchObject({ etat: 'suspendu' });
      await pool.query(`update phone_numbers set display_phone_number = '+44 999 0000013' where id = $1`, [pn]);
      expect(await abonnements.etatDeLEspace(t)).toMatchObject({ etat: 'suspendu' });
    } finally {
      await pool.query('delete from phone_numbers where tenant_id = $1', [t]);
      await pool.query('delete from waba where tenant_id = $1', [t]);
    }
  });

  it('🔴 le CHECK des pauses de campagne accepte le motif `numero_suspendu`', async () => {
    const def = await pool.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'campaigns_pause_reason_check'`,
    );
    expect(def.rows[0]?.def).toContain('numero_suspendu');
    expect(def.rows[0]?.def).toContain('numero_delie');
  });
});
