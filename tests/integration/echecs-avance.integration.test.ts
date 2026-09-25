import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgErreursLivraisonStore } from '../../src/ops/erreurs-livraison.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * LES ÉCHECS D'AVANCE DE SCÉNARIO (lot 4 du plan post-audit, migration 0108).
 *
 * 🔴 EN INTÉGRATION parce que tout ce qui compte ici est du SQL : le rattachement du contact par la règle de
 * routage des entrants (`matchWaIdPredicat`, et non une colonne `wa_id` qui n'existe pas), la fusion avec les
 * erreurs de campagne dans une seule liste triée, et le scope tenant. Un faux prouverait ma lecture, pas la
 * requête.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('échecs d’avance de scénario (Postgres)', () => {
  let pool: Pool;
  let store: PgErreursLivraisonStore;
  let tenantId = '';
  let autreTenant = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    store = new PgErreursLivraisonStore(pool);
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-avance-echecs') returning id`)).rows[0]!.id;
    autreTenant = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-avance-echecs-2') returning id`)).rows[0]!.id;
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenant]) if (t) await pool.query('delete from tenants where id = $1', [t]).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('🔴 un échec écrit est RELU dans le journal, avec son origine « scenario »', async () => {
    await store.enregistrerEchecAvance({ tenantId, waId: '33600000301', erreur: 'Meta indisponible', messageId: 'wamid.301' });
    const erreurs = await store.lister(tenantId);
    const ligne = erreurs.find((e) => e.telephone === '33600000301');
    expect(ligne).toBeDefined();
    expect(ligne!.origine).toBe('scenario');
    expect(ligne!.message).toBe('Meta indisponible');
    // Pas de campagne derrière : le dire avec `null` plutôt qu'avec une chaîne vide qui ressemblerait à un nom.
    expect(ligne!.campaignId).toBeNull();
    expect(ligne!.code).toBeNull();
  });

  it('🔴 le contact est rattaché par la règle de routage des ENTRANTS, pas par une colonne wa_id', async () => {
    // C'est la seule façon correcte : `contacts` n'a pas de colonne `wa_id`, le rattachement se fait sur
    // l'E.164, les chiffres nus, ou le BSUID (`matchWaIdPredicat`).
    await pool.query(
      `insert into contacts (tenant_id, phone_e164, profile_name) values ($1, '+33600000302', 'Alice Test')`,
      [tenantId],
    );
    await store.enregistrerEchecAvance({ tenantId, waId: '33600000302', erreur: 'boom' });
    const ligne = (await store.lister(tenantId)).find((e) => e.telephone === '33600000302');
    expect(ligne?.contactNom).toBe('Alice Test');
  });

  it('🔴 scope tenant : l’échec d’un espace n’apparaît jamais dans un autre', async () => {
    // Le pooler est superuser, la RLS ne joue pas : ce filtre EST le contrôle.
    await store.enregistrerEchecAvance({ tenantId: autreTenant, waId: '33600000303', erreur: 'chez le voisin' });
    const chezNous = await store.lister(tenantId);
    expect(chezNous.some((e) => e.telephone === '33600000303')).toBe(false);
  });

  it('la recherche porte sur le message et sur le numéro', async () => {
    await store.enregistrerEchecAvance({ tenantId, waId: '33600000304', erreur: 'timeout du modele' });
    expect((await store.lister(tenantId, { q: 'timeout du modele' })).some((e) => e.telephone === '33600000304')).toBe(true);
    expect((await store.lister(tenantId, { q: '33600000304' })).some((e) => e.telephone === '33600000304')).toBe(true);
    expect((await store.lister(tenantId, { q: 'introuvable-xyz' })).some((e) => e.telephone === '33600000304')).toBe(false);
  });

  it('🔴 filtrer par CODE Meta exclut les échecs de scénario : ils n’en portent aucun', async () => {
    // Sinon le filtre ne filtrerait pas : demander « les erreurs 131049 » rendrait aussi des lignes sans code.
    await store.enregistrerEchecAvance({ tenantId, waId: '33600000305', erreur: 'sans code' });
    const filtrees = await store.lister(tenantId, { code: 131049 });
    expect(filtrees.some((e) => e.origine === 'scenario')).toBe(false);
  });

  it('la purge de rétention efface les vieux, et EPARGNE les récents', async () => {
    await store.enregistrerEchecAvance({ tenantId, waId: '33600000306', erreur: 'tout frais' });
    await pool.query(
      `insert into workflow_advance_failures (tenant_id, wa_id, erreur, at) values ($1, '33600000307', 'tres vieux', now() - interval '400 days')`,
      [tenantId],
    );
    const efface = await store.purgeEchecsAvanceOlderThan(90);
    expect(efface).toBeGreaterThanOrEqual(1);
    const restants = await store.lister(tenantId);
    expect(restants.some((e) => e.telephone === '33600000307')).toBe(false);
    expect(restants.some((e) => e.telephone === '33600000306')).toBe(true);
  });
});
