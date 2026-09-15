import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgToolCatalog } from '../../src/agent/catalog.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * CE QU'UN OUTIL FAIT DE LA RÉPONSE, ÉCRIT SUR L'OUTIL (migration 0150).
 *
 * 🔴 POURQUOI EN INTÉGRATION. Ce lot déplace une donnée d'une table à une autre, et le seul endroit où le
 * déplacement est vrai ou faux est l'`insert`. Un faux magasin rendrait ce qu'on lui fait rendre, y compris
 * la liste vide que la vraie requête écrivait jusqu'ici : c'est exactement le défaut qu'on répare, et un test
 * unitaire l'aurait laissé passer pendant des mois.
 *
 * 🔴 CE QUE ÇA RÉPARE AU PASSAGE, mesuré le 2026-09-15. `agent_tools.output_paths` existe depuis la migration
 * 0086 et l'insertion y écrivait `'{}'::text[]` en toutes lettres, avec une justification (« la REQUÊTE les
 * porte ») juste pour l'ancienne conception. Or le bac à sable (`connecteurSimule`) bouclait DÉJÀ sur cette
 * colonne, donc il rendait un objet VIDE en promettant « exactement ce que l'agent recevra ». La remplir rend
 * cette promesse vraie.
 */
describe.skipIf(!url)('la nature d un outil de connecteur (Postgres)', () => {
  let pool: Pool;
  let catalogue: PgToolCatalog;
  let tenantId: string;
  let agentId: string;
  let sourceId: string;
  let requeteId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    catalogue = new PgToolCatalog(pool);

    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-outil-nature') returning id`,
    )).rows[0]!.id;

    // ⚠️ `mention_ia` et `modele` sont NOT NULL SANS défaut (migration 0086) : les omettre lève en 23502 et
    // fait échouer TOUT le fichier dans son `beforeAll`, ce qui est arrivé le 2026-09-15 sur un autre test.
    agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, objectif, mention_ia, modele)
       values ($1, 'itest', 'aider', 'Je suis une IA.', 'test/modele') returning id`,
      [tenantId],
    )).rows[0]!.id;

    sourceId = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'http', 'itest-source', 'https://exemple.test/api', 'none', 'active') returning id`,
      [tenantId],
    )).rows[0]!.id;

    // L'appel déclare TROIS champs : c'est son DÉFAUT de pré-remplissage, et surtout ce dont l'outil doit
    // pouvoir s'écarter. Un test où les deux listes coïncident ne prouverait rien.
    requeteId = (await pool.query<{ id: string }>(
      `insert into connector_requests (tenant_id, source_id, label, method, path, output_paths)
       values ($1, $2, 'itest-appel', 'POST', '/x', $3::text[]) returning id`,
      [tenantId, sourceId, ['statut', 'email', 'interne']],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const base = (nom: string) => ({
    sourceId, requestId: requeteId, name: nom, title: 'Titre', description: 'sert à ça',
    nePasUtiliser: 'jamais pour ça', params: [], risk: 'write' as const,
  });

  it('🔴 un outil qui INTÈGRE porte SES champs, pas ceux de l appel', async () => {
    // C'est tout le chantier : l'appel en déclare trois, cet agent n'en lit qu'un. Tant que la liste vivait
    // sur l'appel, restreindre pour un agent restreignait pour tous.
    const outil = await catalogue.ajouterConnecteur(tenantId, agentId, {
      ...base('lire_un'), nature: 'integre', outputPaths: ['statut'],
    });
    expect(outil).not.toBeNull();
    expect(outil!.nature).toBe('integre');
    expect(outil!.outputPaths).toEqual(['statut']);
  });

  it('🔴 et la liste est bien RELUE depuis la base, pas seulement rendue par l insert', async () => {
    // Un `returning` généreux masquerait une colonne non écrite. On relit par le chemin chaud.
    const outil = await catalogue.ajouterConnecteur(tenantId, agentId, {
      ...base('lire_deux'), nature: 'integre', outputPaths: ['statut', 'email'],
    });
    const relu = (await catalogue.listToutes(tenantId, agentId)).find((o) => o.id === outil!.id);
    expect(relu?.outputPaths).toEqual(['statut', 'email']);
    expect(relu?.nature).toBe('integre');
  });

  it('🔴 un outil qui POUSSE garde une liste VIDE, et c est un état valide', async () => {
    // Avant 0150, cet état était impossible à déclarer et refusé à l'exécution. C'est pourtant le cas de
    // la moitié des appels qu'un client veut brancher : poser une étiquette, créer une fiche.
    const outil = await catalogue.ajouterConnecteur(tenantId, agentId, {
      ...base('pousser_un'), nature: 'pousse', outputPaths: [],
    });
    expect(outil!.nature).toBe('pousse');
    expect(outil!.outputPaths).toEqual([]);
  });

  it('🔴 des champs cochés sur un POUSSE sont IGNORÉS, pas enregistrés à moitié', async () => {
    // Deux champs qui doivent rester cohérents et qu'on écrirait indépendamment finiraient par diverger :
    // un outil « pousse » portant des chemins ferait croire à une lecture que le résolveur ne fait pas.
    const outil = await catalogue.ajouterConnecteur(tenantId, agentId, {
      ...base('pousser_deux'), nature: 'pousse', outputPaths: ['statut'],
    });
    expect(outil!.outputPaths).toEqual([]);
  });

  it('⚠️ la base REFUSE une nature inconnue : le CHECK est la ceinture du type TypeScript', async () => {
    // Le type ne protège que le code compilé ici. Une migration future, un script d'exploitation ou un
    // `psql` à la main passeraient à côté.
    await expect(pool.query(
      `update agent_tools set nature = 'peut-etre' where tenant_id = $1`, [tenantId],
    )).rejects.toThrow(/agent_tools_nature_chk/);
  });
});
