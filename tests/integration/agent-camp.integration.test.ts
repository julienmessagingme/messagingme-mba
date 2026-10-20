import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgToolCatalog } from '../../src/agent/catalog.pg';
import { OutilNonActivable } from '../../src/agent/catalog';
import { PgAgentStore } from '../../src/agent/agent-store.pg';
import { CampEnConflit } from '../../src/agent/agent-store';

const url = process.env.DATABASE_URL ?? '';

/**
 * CHOISIR SON CAMP, contre un vrai Postgres (`src/agent/camp.ts`, demande de Julien du 2026-10-20). La règle est en
 * TypeScript et testée à part (`tests/agent-camp.test.ts`) ; ce qui ne se prouve qu'ici, c'est que les deux stores lisent
 * les BONS outils (actifs, de cet agent) et la BONNE fiche, à l'activation, au `PATCH` d'une cible et à l'écriture des
 * règles d'arrêt.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('choisir son camp (Postgres)', () => {
  let pool: Pool;
  let catalogue: PgToolCatalog;
  let agents: PgAgentStore;
  let tenantId: string;
  let agentId: string;
  let autreAgentId: string;
  let adminId: string;

  const MOTS = { description: 'quand le contact veut un humain', nePasUtiliser: 'jamais par prudence', params: [] };
  const QUESTIONS = [{ champ: 'prenom', question: 'ton prénom', valeurs: [] }];

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    catalogue = new PgToolCatalog(pool);
    agents = new PgAgentStore(pool);
    const t = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-camp') returning id`);
    tenantId = t.rows[0]!.id;
    const u = await pool.query<{ id: string }>(
      `insert into users (tenant_id, email, role, password_hash) values ($1, 'itest-camp@example.test', 'admin', 'x') returning id`,
      [tenantId],
    );
    adminId = u.rows[0]!.id;
    const a = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-camp', 'Je suis une IA.', 'm') returning id`,
      [tenantId],
    );
    agentId = a.rows[0]!.id;
    const a2 = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-camp-2', 'Je suis une IA.', 'm') returning id`,
      [tenantId],
    );
    autreAgentId = a2.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const poser = async (agent: string, handler: string, name: string, title: string, cible: unknown) => {
    const o = await catalogue.ajouter(tenantId, agent, {
      handler, cible: cible as never, name, title, ...MOTS, risk: 'write',
    });
    if (!o) throw new Error(`pose refusée : ${name}`);
    return o.id;
  };

  it('🔴 les trois portes refusent le camp opposé, et laissent passer une fois le premier désactivé', async () => {
    const passerLaMain = await poser(agentId, 'escalader', 'mba_escalader_humain', 'Passer la main à un humain', null);
    const qualifier = await poser(agentId, 'qualifier_transferer', 'mba_qualifier', 'Qualifier le candidat',
      { handler: 'qualifier_transferer', questions: QUESTIONS });
    const enchaine = await poser(agentId, 'enchainer', 'mba_enchainer', 'Étiqueter',
      { handler: 'enchainer', etapes: [{ type: 'tag', tag: 'chaud' }] });

    // « Passer la main » actif : la qualification est refusée, avec le nom de l'outil à désactiver.
    expect(await catalogue.activer(tenantId, agentId, passerLaMain, true, adminId)).not.toBeNull();
    await expect(catalogue.activer(tenantId, agentId, qualifier, true, adminId))
      .rejects.toThrow(OutilNonActivable);
    await expect(catalogue.activer(tenantId, agentId, qualifier, true, adminId))
      .rejects.toMatchObject({ raison: expect.stringContaining('« Passer la main à un humain »') });

    // Un enchaînement ACTIF qui deviendrait un transfert est refusé au PATCH ; INACTIF, il s'écrit (jugé à l'activation).
    expect(await catalogue.activer(tenantId, agentId, enchaine, true, adminId)).not.toBeNull();
    const versTransfert = { handler: 'enchainer' as const, etapes: [{ type: 'tag' as const, tag: 'chaud' }, { type: 'transferer' as const }] };
    await expect(catalogue.patch(tenantId, agentId, enchaine, { cible: versTransfert })).rejects.toThrow(OutilNonActivable);
    expect(await catalogue.activer(tenantId, agentId, enchaine, false, adminId)).not.toBeNull();
    expect(await catalogue.patch(tenantId, agentId, enchaine, { cible: versTransfert })).not.toBeNull();

    // « Passer la main » désactivé : la qualification passe ; « Passer la main » est alors refusé à son tour.
    expect(await catalogue.activer(tenantId, agentId, passerLaMain, false, adminId)).not.toBeNull();
    expect(await catalogue.activer(tenantId, agentId, qualifier, true, adminId)).not.toBeNull();
    await expect(catalogue.activer(tenantId, agentId, passerLaMain, true, adminId))
      .rejects.toMatchObject({ raison: expect.stringContaining('« Qualifier le candidat »') });

    // Une règle d'arrêt cochée « passe à un humain » est refusée par le store de la fiche ; décochée, elle s'écrit.
    await expect(agents.patch(tenantId, agentId, {
      contenu: { sorties: [{ code: 'mise_en_relation', label: 'Mise en relation', humain: true }] },
    })).rejects.toThrow(CampEnConflit);
    const ecrit = await agents.patch(tenantId, agentId, { contenu: { sorties: [{ code: 'mise_en_relation', label: 'Mise en relation' }] } });
    expect(ecrit?.contenu.sorties).toEqual([{ code: 'mise_en_relation', label: 'Mise en relation' }]);
  });

  it('🔴 la règle d’arrêt cochée bloque la qualification, et l’AUTRE agent n’est jamais concerné', async () => {
    // Le second agent a une règle qui passe à un humain : sa qualification est refusée, celle du premier n'y est pour rien.
    const fiche = await agents.patch(tenantId, autreAgentId, {
      contenu: { sorties: [{ code: 'conseiller', label: 'Conseiller', humain: true }] },
    });
    expect(fiche?.contenu.sorties).toEqual([{ code: 'conseiller', label: 'Conseiller', humain: true }]);
    const qualifier = await poser(autreAgentId, 'qualifier_transferer', 'mba_qualifier_2', 'Qualifier',
      { handler: 'qualifier_transferer', questions: QUESTIONS });
    await expect(catalogue.activer(tenantId, autreAgentId, qualifier, true, adminId))
      .rejects.toMatchObject({ raison: expect.stringContaining('la règle d’arrêt « Conseiller »') });
    // Les outils ACTIFS du premier agent (une qualification) ne bloquent pas la règle du second.
    expect(await agents.patch(tenantId, autreAgentId, {
      contenu: { sorties: [{ code: 'conseiller', label: 'Conseiller enfin', humain: true }] },
    })).not.toBeNull();
  });
});
