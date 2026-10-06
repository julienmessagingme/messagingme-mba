import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgLiberationStore, DidwwNonConfigure } from '../../src/numero/liberation.pg';
import { PgAbonnementsNumeroStore } from '../../src/stripe/abonnements.pg';
import { PgNumerosFournisStore } from '../../src/otp/store.pg';

/**
 * LA LIBÉRATION D'UN NUMÉRO FOURNI (lot 4, livraison B), sur une vraie base.
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : la transaction entière (délié, réserve, date) annulée par un échec de DIDWW, le
 * verrou qui laisse passer un abonnement déjà pris, l'espace réabonné qui garde son numéro, et un numéro apporté par le
 * client que la libération ne délie jamais.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const N = '449990000031';
const MAINTENANT = new Date();
const IL_Y_A_8_JOURS = new Date(MAINTENANT.getTime() - 8 * 24 * 3_600_000);
const IL_Y_A_6_JOURS = new Date(MAINTENANT.getTime() - 6 * 24 * 3_600_000);

describe.skipIf(!url)('la libération d’un numéro fourni (lot 4, B)', () => {
  let pool: Pool;
  let liberation: PgLiberationStore;
  let abonnements: PgAbonnementsNumeroStore;
  let numeros: PgNumerosFournisStore;
  let t = '';
  const suffixe = randomUUID().slice(0, 8);
  const PN = `itest-lib-pn-${suffixe}`;
  const WABA = `itest-lib-waba-${suffixe}`;
  const DID = `did-itest-lib-${suffixe}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    liberation = new PgLiberationStore(pool);
    abonnements = new PgAbonnementsNumeroStore(pool);
    numeros = new PgNumerosFournisStore(pool);
    t = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-liberation') returning id`)).rows[0]!.id;
    await pool.query(`insert into waba (id, tenant_id, name) values ($1, $2, 'itest')`, [WABA, t]);
  });

  afterAll(async () => {
    await pool.query(`delete from numeros_fournis where numero = $1`, [N]);
    await pool.query('delete from tenants where id = $1', [t]);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('delete from abonnements_numero where tenant_id = $1', [t]);
    await pool.query('delete from campaigns where tenant_id = $1', [t]);
    await pool.query('delete from phone_numbers where tenant_id = $1', [t]);
    await pool.query(`delete from numeros_fournis where numero = $1`, [N]);
    await numeros.declarer(N, DID);
    expect(await numeros.attribuer(t)).toMatchObject({ numero: N });
  });

  const fini = (abonnementId: string, finiLe: Date) => pool.query(
    `insert into abonnements_numero (stripe_subscription_id, tenant_id, livemode, statut, fini_le) values ($1, $2, false, 'resilie', $3)`,
    [abonnementId, t, finiLe],
  );
  const connecter = (affiche: string | null) => pool.query(
    `insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, status) values ($1, $2, $3, $4, 'CONNECTED')`,
    [PN, t, WABA, affiche],
  );
  const campagne = async (status: string, pauseReason: string | null = null, channel = 'whatsapp') => (await pool.query<{ id: string }>(
    `insert into campaigns (tenant_id, phone_number_id, name, category, template_name, template_language, status, param_mapping, channel, pause_reason)
     values ($1, $2, 'itest-lib', 'marketing', 'tpl', 'fr', $3, '[]'::jsonb, $4, $5) returning id`,
    [t, PN, status, channel, pauseReason],
  )).rows[0]!.id;
  const reserve = async () => (await pool.query<{ statut: string; tenant_id: string | null }>(
    `select statut, tenant_id from numeros_fournis where numero = $1`, [N],
  )).rows[0]!;
  const liberee = async (id: string) => (await pool.query<{ libere_le: Date | null }>(
    `select libere_le from abonnements_numero where stripe_subscription_id = $1`, [id],
  )).rows[0]!.libere_le;
  const delieLe = async () => (await pool.query<{ delie_le: Date | null }>(`select delie_le from phone_numbers where id = $1`, [PN])).rows[0]!.delie_le;
  const numerosDeLEspace = async () => Number((await pool.query<{ n: string }>(`select count(*) as n from phone_numbers where tenant_id = $1`, [t])).rows[0]!.n);
  const pause = async (id: string) => (await pool.query<{ status: string; pause_reason: string | null }>(
    `select status, pause_reason from campaigns where id = $1`, [id],
  )).rows[0]!;

  it('🔴 connecté : RETIRÉ de l’espace (qui redevient sans numéro), campagnes WhatsApp en pause, résilié chez DIDWW, « résilié » dans la réserve, date posée', async () => {
    await fini('sub_lib_a', IL_Y_A_8_JOURS);
    await connecter('+44 999 0000031');
    const enCours = await campagne('running');
    const suspendue = await campagne('paused', 'numero_suspendu');
    const rcs = await campagne('running', null, 'rcs');
    const resilies: string[] = [];
    expect(await liberation.liberer(t, 'sub_lib_a', async (d) => { resilies.push(d); }, MAINTENANT))
      .toEqual({ fait: 'resilie', numero: N, retire: true });
    expect(resilies).toEqual([DID]);
    expect(await reserve()).toEqual({ statut: 'resilie', tenant_id: null });
    expect(await liberee('sub_lib_a')).toBeInstanceOf(Date);
    // 🔴 La ligne du numéro QUITTE l'espace (rouge 1 de la relecture de B) : délié mais gardé, il interdisait pour
    // toujours d'en connecter un autre (un seul numéro par espace).
    expect(await numerosDeLEspace()).toBe(0);
    expect(await pause(enCours)).toEqual({ status: 'paused', pause_reason: 'numero_delie' });
    expect(await pause(suspendue)).toEqual({ status: 'paused', pause_reason: 'numero_delie' });
    expect(await pause(rcs)).toEqual({ status: 'running', pause_reason: null });
    expect(await abonnements.etatDeLEspace(t)).toMatchObject({ etat: 'libere' });
    // Une seconde fois : rien à faire, rien d'appelé.
    expect(await liberation.liberer(t, 'sub_lib_a', async () => { throw new Error('jamais'); }, MAINTENANT)).toEqual({ fait: 'rien' });
  });

  it('🔴 DIDWW échoue : TOUT est annulé (ni délié, ni réserve, ni date), et le tour suivant rejoue', async () => {
    await fini('sub_lib_b', IL_Y_A_8_JOURS);
    await connecter('+44 999 0000031');
    await expect(liberation.liberer(t, 'sub_lib_b', async () => { throw new Error('DIDWW a refusé (403)'); }, MAINTENANT)).rejects.toThrow(/403/);
    expect(await numerosDeLEspace()).toBe(1);
    expect(await delieLe()).toBeNull();
    expect(await reserve()).toEqual({ statut: 'attribue', tenant_id: t });
    expect(await liberee('sub_lib_b')).toBeNull();
    expect(await abonnements.etatDeLEspace(t)).toMatchObject({ etat: 'suspendu' });
    // DIDWW non configuré : même chose, avec sa propre erreur.
    await expect(liberation.liberer(t, 'sub_lib_b', null, MAINTENANT)).rejects.toBeInstanceOf(DidwwNonConfigure);
    expect(await reserve()).toEqual({ statut: 'attribue', tenant_id: t });
    expect(await liberation.liberer(t, 'sub_lib_b', async () => {}, MAINTENANT)).toMatchObject({ fait: 'resilie' });
  });

  it('jamais vu de Meta (ni connecté, ni code capté) : rendu « libre » à la réserve, rien chez DIDWW', async () => {
    await fini('sub_lib_c', IL_Y_A_8_JOURS);
    expect(await liberation.liberer(t, 'sub_lib_c', async () => { throw new Error('jamais'); }, MAINTENANT)).toEqual({ fait: 'libre', numero: N });
    expect(await reserve()).toEqual({ statut: 'libre', tenant_id: null });
    expect(await liberee('sub_lib_c')).toBeInstanceOf(Date);
  });

  it('🔴 un code de Meta capté il y a UN MOIS, sans connexion : la purge l’a gardé, Meta l’a vu, il est résilié (pas rendu)', async () => {
    await fini('sub_lib_d', IL_Y_A_8_JOURS);
    const id = (await pool.query<{ id: string }>(`select id from numeros_fournis where numero = $1`, [N])).rows[0]!.id;
    await pool.query(
      `insert into codes_verification (numero_id, appel_id, code, recu_le) values ($1, $2, '123456', now() - interval '30 days')`,
      [id, `appel-${suffixe}`],
    );
    // 🔴 Rouge 2 de la relecture de B : la purge effaçait tout code de plus de 7 jours, donc la preuve, toujours,
    // avant la libération. Elle épargne désormais les codes d'un numéro encore attribué.
    await numeros.purgerAvant(7);
    expect(await liberation.liberer(t, 'sub_lib_d', async () => {}, MAINTENANT)).toEqual({ fait: 'resilie', numero: N, retire: false });
  });

  it('🔴 un numéro APPORTÉ par le client (autres chiffres) ne quitte jamais l’espace', async () => {
    await fini('sub_lib_e', IL_Y_A_8_JOURS);
    await connecter('+33 6 12 34 56 78');
    const enCours = await campagne('running');
    expect(await liberation.liberer(t, 'sub_lib_e', async () => { throw new Error('jamais'); }, MAINTENANT)).toEqual({ fait: 'libre', numero: N });
    expect(await numerosDeLEspace()).toBe(1);
    expect(await delieLe()).toBeNull();
    expect(await pause(enCours)).toEqual({ status: 'running', pause_reason: null });
  });

  it('chiffres inconnus (affichage vide) : traités comme le numéro fourni, retiré', async () => {
    await fini('sub_lib_f', IL_Y_A_8_JOURS);
    await connecter(null);
    expect(await liberation.liberer(t, 'sub_lib_f', async () => {}, MAINTENANT)).toEqual({ fait: 'resilie', numero: N, retire: true });
    expect(await numerosDeLEspace()).toBe(0);
  });

  it('🔴 pas encore dû (6 jours), ou réabonné entre-temps : rien ne bouge', async () => {
    await fini('sub_lib_g', IL_Y_A_6_JOURS);
    expect(await liberation.liberer(t, 'sub_lib_g', async () => { throw new Error('jamais'); }, MAINTENANT)).toEqual({ fait: 'rien' });
    await pool.query('delete from abonnements_numero where tenant_id = $1', [t]);
    await fini('sub_lib_h', IL_Y_A_8_JOURS);
    await pool.query(
      `insert into abonnements_numero (stripe_subscription_id, tenant_id, livemode, statut) values ('sub_lib_vivant', $1, false, 'actif')`, [t],
    );
    expect(await liberation.liberer(t, 'sub_lib_h', async () => { throw new Error('jamais'); }, MAINTENANT)).toEqual({ fait: 'rien' });
    expect(await reserve()).toEqual({ statut: 'attribue', tenant_id: t });
  });

  it('fini sans numéro attribué (rendu par « Abandonner ») : seule la date se pose', async () => {
    await numeros.rendre(t);
    await fini('sub_lib_i', IL_Y_A_8_JOURS);
    expect(await liberation.liberer(t, 'sub_lib_i', async () => { throw new Error('jamais'); }, MAINTENANT)).toEqual({ fait: 'sans_numero' });
    expect(await liberee('sub_lib_i')).toBeInstanceOf(Date);
  });
});
