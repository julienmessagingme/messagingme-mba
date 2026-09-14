import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgHistoriqueStore } from '../../src/reglages/historique.pg';
import type { LigneHistorique } from '../../src/reglages/historique';

/**
 * L'HISTORIQUE DES RÉGLAGES, CONTRE UNE VRAIE BASE.
 *
 * 🔴 CE QUI NE PEUT PAS SE VOIR AILLEURS : `surface_id` est NULLABLE, et pour le Meta Business Agent il vaut
 * toujours `null`. Une requête écrite `surface_id = $3` rendrait alors ZÉRO ligne, sans lever, sur la surface
 * qui en a le plus besoin. Aucun test unitaire ne le verrait (un faux store rend ce qu'on lui dit de rendre),
 * et le compilateur encore moins.
 *
 * ⚠️ Ne PAS le lancer en local : le `DATABASE_URL` du `.env` local pointe sur la base de PRODUCTION, et ce
 * fichier crée et supprime des tenants. La CI monte un Postgres jetable pour ça (job `integration`).
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('l historique des reglages', () => {
  let pool: Pool;
  let store: PgHistoriqueStore;
  let tenantId = '';
  let autreTenant = '';
  let agentId = '';

  const ligne = (sur: Partial<LigneHistorique> = {}): LigneHistorique => ({
    surface: 'mba', surfaceId: null, element: 'faq', operation: 'ajout',
    cible: 'faq_1', libelle: 'FAQ : horaires du dimanche', avant: null, apres: { q: 'horaires' },
    origine: 'assistant', acteurEmail: 'julien@messagingme.fr', acteurId: null, ...sur,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgHistoriqueStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-historique') returning id`,
    )).rows[0]!.id;
    autreTenant = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-historique-autre') returning id`,
    )).rows[0]!.id;
    agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label) values ($1, 'agent d essai') returning id`, [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query(`delete from tenants where id = any($1::uuid[])`, [[tenantId, autreTenant]]);
    await pool.end();
  });

  it('🔴 une ligne de MBA (surface_id NULL) se relit : c’est le cas que `= $3` casserait en silence', async () => {
    await store.ecrire(tenantId, ligne());
    const lignes = await store.lister(tenantId, { surface: 'mba' });
    expect(lignes).toHaveLength(1);
    expect(lignes[0]?.libelle).toBe('FAQ : horaires du dimanche');
    expect(lignes[0]?.surfaceId).toBeNull();
  });

  it('une ligne d’agent se relit sur SON agent, et pas sur un autre', async () => {
    await store.ecrire(tenantId, ligne({ surface: 'agent', surfaceId: agentId, element: 'fiche_agent' }));
    expect(await store.lister(tenantId, { surface: 'agent', surfaceId: agentId })).toHaveLength(1);
    // ⚠️ Et la surface MBA ne les mélange pas : ce sont deux onglets distincts.
    expect((await store.lister(tenantId, { surface: 'mba' })).every((l) => l.surfaceId === null)).toBe(true);
  });

  it('🔴 un espace ne voit pas l’historique d’un autre', async () => {
    await store.ecrire(autreTenant, ligne({ libelle: 'chez le voisin' }));
    const chezNous = await store.lister(tenantId, { surface: 'mba' });
    expect(chezNous.some((l) => l.libelle === 'chez le voisin')).toBe(false);
  });

  it('🔴 la BASE refuse une suppression sans son contenu, pas seulement le code', async () => {
    // On contourne la garde applicative pour éprouver le CHECK lui-même : c'est lui qui tient la promesse
    // quand un futur appelant écrira en SQL direct.
    await expect(pool.query(
      `insert into reglages_historique (tenant_id, surface, element, operation, libelle, origine)
       values ($1, 'mba', 'faq', 'suppression', 'sans contenu', 'formulaire')`,
      [tenantId],
    )).rejects.toThrow(/reglages_historique_suppression_garde/);
  });

  it('🔴 la BASE refuse une ligne d’agent sans agent, et une ligne de MBA avec', async () => {
    await expect(pool.query(
      `insert into reglages_historique (tenant_id, surface, element, operation, libelle, origine)
       values ($1, 'agent', 'faq', 'ajout', 'sans agent', 'formulaire')`,
      [tenantId],
    )).rejects.toThrow(/reglages_historique_surface_id_chk/);
    await expect(pool.query(
      `insert into reglages_historique (tenant_id, surface, surface_id, element, operation, libelle, origine)
       values ($1, 'mba', $2, 'faq', 'avec agent', 'formulaire')`,
      [tenantId, agentId],
    )).rejects.toThrow(/reglages_historique_surface_id_chk/);
  });

  it('⚠️ le contenu effacé fait l’aller-retour en jsonb, tel quel', async () => {
    const efface = { question: 'Horaires du dimanche', reponse: 'Fermé', tags: ['horaires'] };
    await store.ecrire(tenantId, ligne({ operation: 'suppression', avant: efface, apres: null, libelle: 'FAQ supprimée' }));
    const lu = (await store.lister(tenantId, { surface: 'mba' })).find((l) => l.libelle === 'FAQ supprimée');
    // C'est TOUT l'intérêt de la table : pouvoir recréer ce que Meta ne garde pas.
    expect(lu?.avant).toEqual(efface);
  });

  it('les lignes reviennent les plus RÉCENTES d’abord', async () => {
    const lignes = await store.lister(tenantId, { surface: 'mba' });
    const dates = lignes.map((l) => l.at);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('⚠️ le départ d’un collaborateur garde son e-mail sur la ligne', async () => {
    const userId = (await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role) values ($1, 'partant@itest.test', 'agent') returning id`,
      [tenantId],
    )).rows[0]!.id;
    await store.ecrire(tenantId, ligne({ libelle: 'fait par le partant', acteurId: userId, acteurEmail: 'partant@itest.test' }));
    await pool.query(`delete from users where id = $1`, [userId]);
    const lu = (await store.lister(tenantId, { surface: 'mba' })).find((l) => l.libelle === 'fait par le partant');
    // 🔴 L'identifiant part (`on delete set null`), l'e-mail RESTE : sans lui, supprimer un compte effacerait
    // le « qui » de tout ce qu'il a fait.
    expect(lu?.acteurId).toBeNull();
    expect(lu?.acteurEmail).toBe('partant@itest.test');
  });
});
