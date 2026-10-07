import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgOffresStore } from '../../src/offres/offre.pg';
import { PgContactStore } from '../../src/crm/contact-store.pg';
import { PgAutomationStore, type AutomationInput } from '../../src/automation/store.pg';
import { PgUserStore } from '../../src/user/store.pg';
import { PgCompteurDebit } from '../../src/db/debit.pg';
import { QuotaModeles } from '../../src/offres/compteurs';

/**
 * L'OFFRE CALCULÉE (migration 0218, lot 6 livraison A), sur une vraie base.
 *
 * 🔴 CE QU'AUCUN TEST UNITAIRE NE VOIT : la fonction SQL `offre_de_l_espace`, seule définition de l'offre, lue par le
 * code ET par les balayages ; l'unicité d'un abonnement Pro vivant par espace ; la reprise des espaces existants.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION. La CI monte un
 * Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';
const JUIN = new Date('2026-06-01T00:00:00Z');

describe.skipIf(!url)('l’offre calculée (0218)', () => {
  let pool: Pool;
  let offres: PgOffresStore;
  const espaces: string[] = [];

  async function espace(nom: string, entreprise = false, utilisateurs: number | null = null): Promise<string> {
    const id = (await pool.query<{ id: string }>(
      `insert into tenants (name, offre_entreprise, entreprise_utilisateurs) values ($1, $2, $3) returning id`,
      [nom, entreprise, utilisateurs],
    )).rows[0]!.id;
    espaces.push(id);
    return id;
  }
  async function pro(tenantId: string, abonnementId: string, finiLe: Date | null, livemode = true): Promise<void> {
    await pool.query(
      `insert into abonnements_offre (stripe_subscription_id, tenant_id, periodicite, livemode, fini_le, fin_raison, statut)
       values ($1, $2, 'mois', $3, $4, $5, $6)`,
      [abonnementId, tenantId, livemode, finiLe, finiLe ? 'resiliation' : null, finiLe ? 'resilie' : 'actif'],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    offres = new PgOffresStore(pool);
  });

  afterAll(async () => {
    await pool.query('delete from tenants where id = any($1::uuid[])', [espaces]);
    await pool.end();
  });

  it('un espace neuf est en Base, sans retour en Base', async () => {
    const t = await espace('itest-offre-base');
    const o = await offres.offreDe(t);
    expect(o.offre).toBe('base');
    expect(o.droits.limites.contacts).toBe(100);
    expect(o.retourEnBaseLe).toBeNull();
  });

  it('un abonnement Pro vivant fait le Pro, quel que soit son mode', async () => {
    const t = await espace('itest-offre-pro');
    await pro(t, 'sub_itestoffrepro', null, false);
    expect((await offres.offreDe(t)).offre).toBe('pro');
  });

  it('🔴 un Pro fini ramène en Base, et date le retour', async () => {
    const t = await espace('itest-offre-pro-fini');
    await pro(t, 'sub_itestoffrefini', JUIN);
    const o = await offres.offreDe(t);
    expect(o.offre).toBe('base');
    expect(o.retourEnBaseLe?.toISOString()).toBe(JUIN.toISOString());
  });

  it('l\'Entreprise l\'emporte sur un Pro, avec sa limite d\'utilisateurs (vide = sans limite)', async () => {
    const t = await espace('itest-offre-ent', true, 12);
    await pro(t, 'sub_itestoffreent', null);
    const o = await offres.offreDe(t);
    expect(o.offre).toBe('entreprise');
    expect(o.droits.limites.utilisateurs).toBe(12);
    const sans = await espace('itest-offre-ent-sans', true, null);
    expect((await offres.offreDe(sans)).droits.limites.utilisateurs).toBeNull();
  });

  it('un seul abonnement Pro vivant par espace', async () => {
    const t = await espace('itest-offre-unique');
    await pro(t, 'sub_itestoffreuna', null);
    await expect(pro(t, 'sub_itestoffreunb', null)).rejects.toThrow(/abonnements_offre_un_vivant_par_espace/);
  });

  it('la fonction SQL et le store disent la même chose, et un espace inconnu est en Base', async () => {
    const t = await espace('itest-offre-sql');
    await pro(t, 'sub_itestoffresql', null);
    const r = await pool.query<{ o: string }>('select offre_de_l_espace($1) as o', [t]);
    expect(r.rows[0]!.o).toBe('pro');
    const inconnu = '00000000-0000-4000-8000-000000000000';
    expect((await pool.query<{ o: string }>('select offre_de_l_espace($1) as o', [inconnu])).rows[0]!.o).toBe('base');
    expect((await offres.offreDe(inconnu)).offre).toBe('base');
  });

  it('une fin sans raison connue est refusée, une raison sans fin aussi', async () => {
    const t = await espace('itest-offre-raison');
    await expect(pool.query(
      `insert into abonnements_offre (stripe_subscription_id, tenant_id, periodicite, livemode, fin_raison) values ('sub_itestraison', $1, 'an', true, 'impaye')`,
      [t],
    )).rejects.toThrow(/abonnements_offre_fin_raison_chk/);
  });

  it('🔴 l’usage compte ce que les gardes comptent : fiches créées actives, automations allumées du client, membres actifs', async () => {
    const t = await espace('itest-offre-usage');
    const contacts = new PgContactStore(pool);
    const tel = (n: number) => `+3369991${String(n).padStart(4, '0')}`;
    for (const n of [1, 2, 3]) {
      await contacts.upsertByPhoneReturningId({ tenantId: t, phoneE164: tel(n), profileName: null, fields: {}, optInStatus: 'unknown' });
    }
    await pool.query('update contacts set deleted_at = now() where tenant_id = $1 and phone_e164 = $2', [t, tel(3)]);
    // Née d'un entrant : jamais comptée.
    await contacts.upsertFromInbound(t, tel(4).slice(1), 'Inconnu');

    const wf = (await pool.query<{ id: string }>(`insert into workflows (tenant_id, name) values ($1, 'itest-usage') returning id`, [t])).rows[0]!.id;
    const automations = new PgAutomationStore(pool);
    const entree = (enabled: boolean, possedePar?: string): AutomationInput => ({
      name: 'a', enabled, triggerKind: 'tag_added', triggerConfig: { tag: 'x' }, conditionGroup: null,
      workflowId: wf, startNodeId: null, cooldownSeconds: null, ...(possedePar ? { possedePar } : {}),
    });
    await automations.create(t, entree(true));
    await automations.create(t, entree(false));
    await automations.create(t, entree(true, 'channelsme_link'));

    const users = new PgUserStore(pool);
    await users.createPending(t, 'itest-usage-1@offre.test', 'admin');
    const b = await users.createPending(t, 'itest-usage-2@offre.test', 'agent');
    await users.createPending(t, 'itest-usage-3@offre.test', 'agent');
    expect(await users.setDisabled(t, b.id, true)).toBe('ok');

    expect(await offres.usage(t)).toEqual({ contacts: 2, automations: 1, membres: 2 });
  });

  it('🔴 l’exploitation pose puis retire l’Entreprise, sa limite et sa conservation, sans toucher aux autres réglages', async () => {
    const t = await espace('itest-offre-ops');
    // Un espace sans ligne de réglages (7 sur 9 en production) : l'écriture la crée.
    expect(await offres.lireEntreprise(t)).toEqual({ entreprise: false, utilisateurs: null, conservationJours: null });
    expect(await offres.ecrireEntreprise(t, { entreprise: true, utilisateurs: 10, conservationJours: 365 })).toBe(true);
    expect(await offres.lireEntreprise(t)).toEqual({ entreprise: true, utilisateurs: 10, conservationJours: 365 });
    expect((await offres.offreDe(t)).droits.limites.utilisateurs).toBe(10);
    // La conservation posée est celle que la vue affiche (relecture finale du lot 6).
    expect((await offres.offreDe(t)).droits.limites.conservationJours).toBe(365);

    await pool.query('update tenant_settings set agents_peuvent_prendre = true where tenant_id = $1', [t]);
    expect(await offres.ecrireEntreprise(t, { entreprise: false, utilisateurs: null, conservationJours: null })).toBe(true);
    expect(await offres.lireEntreprise(t)).toEqual({ entreprise: false, utilisateurs: null, conservationJours: null });
    expect((await offres.offreDe(t)).offre).toBe('base');
    const r = await pool.query<{ p: boolean }>('select agents_peuvent_prendre as p from tenant_settings where tenant_id = $1', [t]);
    expect(r.rows[0]!.p).toBe(true);
  });

  it('🔴 les modèles du mois, comptés puis relus sur le VRAI compteur : la lecture ne dépend pas de l’horloge de la copie', async () => {
    // Relecture finale du lot 6 : la lecture comparait la fenêtre du mois au now() de la BASE, et la perdait dès que la
    // base était en avance d'une milliseconde sur la copie. Le compteur en mémoire partage l'horloge du test : seul ce
    // test-ci pouvait le voir.
    const t = await espace('itest-offre-modeles');
    const quota = new QuotaModeles({ offres, compteur: new PgCompteurDebit(pool) });
    expect((await quota.consommer(t)).ok).toBe(true);
    expect((await quota.consommer(t)).ok).toBe(true);
    expect(await quota.etatDuMois(t)).toEqual({ max: 1000, reste: 998 });
    await pool.query("delete from compteurs_debit where starts_with(cle, 'offre.modeles|' || $1)", [t]);
  });

  it('🔴 changer d’offre SANS conservation la laisse telle quelle : aucune purge ne se déclenche', async () => {
    const t = await espace('itest-offre-conservation');
    expect(await offres.ecrireEntreprise(t, { entreprise: true, utilisateurs: null, conservationJours: 0 })).toBe(true);
    expect(await offres.ecrireEntreprise(t, { entreprise: false, utilisateurs: null })).toBe(true);
    expect(await offres.lireEntreprise(t)).toEqual({ entreprise: false, utilisateurs: null, conservationJours: 0 });
  });

  it('un espace inconnu : rien à lire, rien d’écrit', async () => {
    const inconnu = '00000000-0000-4000-8000-000000000001';
    expect(await offres.lireEntreprise(inconnu)).toBeNull();
    expect(await offres.ecrireEntreprise(inconnu, { entreprise: true, utilisateurs: null, conservationJours: null })).toBe(false);
    const r = await pool.query<{ n: number }>('select count(*)::int as n from tenant_settings where tenant_id = $1', [inconnu]);
    expect(r.rows[0]!.n).toBe(0);
  });
});
