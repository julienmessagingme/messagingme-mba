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
