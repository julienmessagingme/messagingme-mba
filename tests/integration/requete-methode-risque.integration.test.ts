import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgToolCatalog } from '../../src/agent/catalog.pg';
import { PgRequeteStore } from '../../src/agent/requetes.pg';
import type { RisqueOutil } from '../../src/agent/catalog';
import type { MethodeConnecteur } from '../../src/agent/http-cible';

const url = process.env.DATABASE_URL ?? '';

/**
 * LE RISQUE D'UN OUTIL SUIT LA MÉTHODE DE SA REQUÊTE, VERS LE HAUT SEULEMENT (relecture de 099fd6c1, 2026-10-05).
 *
 * 🔴 LE DÉFAUT. Le risque d'un outil de connecteur se dérive de la méthode de sa requête à la CRÉATION de l'outil
 * (`risqueSelonMethode`), puis plus jamais : une requête passée de GET à DELETE gardait des outils `read`. En
 * production, l'exécuteur (étape 2) ne leur appliquait alors ni la garde d'autonomie des actions irréversibles, ni
 * le refus `lecture_seule` face à un contact inconnu.
 *
 * 🔴 POURQUOI EN INTÉGRATION. Le correctif vit dans la transaction de `PgRequeteStore.patch` : un faux magasin
 * rendrait ce qu'on lui fait rendre. Le risque est relu EN BASE, dans `agent_tools.risk`, la colonne que
 * l'exécuteur lit.
 */
describe.skipIf(!url)('le risque des outils suit la méthode de leur requête (Postgres)', () => {
  let pool: Pool;
  let catalogue: PgToolCatalog;
  let requetes: PgRequeteStore;
  let tenantId: string;
  let agentId: string;
  let sourceId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    catalogue = new PgToolCatalog(pool);
    requetes = new PgRequeteStore(pool);

    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-requete-methode-risque') returning id`,
    )).rows[0]!.id;

    // ⚠️ `mention_ia` et `modele` sont NOT NULL SANS défaut (migration 0086), et il n'y a pas de colonne `objectif`.
    agentId = (await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, fiche, mention_ia, modele)
       values ($1, 'itest', $2::jsonb, 'Je suis une IA.', 'test/modele') returning id`,
      [tenantId, JSON.stringify({ objectif: 'aider' })],
    )).rows[0]!.id;

    sourceId = (await pool.query<{ id: string }>(
      `insert into agent_tool_sources (tenant_id, kind, label, base_url, auth_kind, status)
       values ($1, 'http', 'itest-source', 'https://exemple.test/api', 'none', 'active') returning id`,
      [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  /** Une requête de la bibliothèque, créée par le vrai magasin. */
  const requete = async (label: string, methode: MethodeConnecteur): Promise<string> =>
    (await requetes.creer(tenantId, {
      sourceId, label, methode, chemin: '/x', parametres: [], entetes: [], corps: { mode: 'aucun' },
      variables: [], outputPaths: [], valeursTest: {},
    })).id;

  /** Un outil branché sur cette requête, au risque que la route lui a donné (dérivé, ou monté par le client). */
  const outil = async (requestId: string, name: string, risk: RisqueOutil): Promise<string> => {
    const cree = await catalogue.ajouterConnecteur(tenantId, agentId, {
      sourceId, requestId, name, title: 'Titre', description: 'sert à ça', nePasUtiliser: 'jamais pour ça',
      risk, nature: 'pousse', outputPaths: [],
    });
    expect(cree?.risk).toBe(risk);
    return cree!.id;
  };

  /** Relu en base, dans la colonne que l'exécuteur lit. */
  const risque = async (outilId: string): Promise<string | undefined> =>
    (await pool.query<{ risk: string }>(
      'select risk from agent_tools where tenant_id = $1 and id = $2', [tenantId, outilId],
    )).rows[0]?.risk;

  it('🔴 un GET passé en DELETE rend ses outils irréversibles', async () => {
    const r = await requete('lire puis effacer', 'GET');
    const o = await outil(r, 'lire_puis_effacer', 'read');
    expect((await requetes.patch(tenantId, r, { methode: 'DELETE' }))?.methode).toBe('DELETE');
    expect(await risque(o)).toBe('irreversible');
  });

  it('🔴 un POST passé en DELETE rend ses outils irréversibles', async () => {
    // Le cas le plus probable en vrai : un appel qui écrit devient un appel qui efface.
    const r = await requete('ecrire puis effacer', 'POST');
    const o = await outil(r, 'ecrire_puis_effacer', 'write');
    await requetes.patch(tenantId, r, { methode: 'DELETE' });
    expect(await risque(o)).toBe('irreversible');
  });

  it('🔴 un GET passé en POST monte ses outils à write, sans toucher à celui que le client avait monté plus haut', async () => {
    const r = await requete('lire puis ecrire', 'GET');
    const lu = await outil(r, 'lire_puis_ecrire', 'read');
    const prudent = await outil(r, 'deja_prudent', 'irreversible');
    await requetes.patch(tenantId, r, { methode: 'POST' });
    expect(await risque(lu)).toBe('write');
    expect(await risque(prudent)).toBe('irreversible');
  });

  it('🔴 le risque ne redescend jamais : un GET passé en DELETE puis repassé en GET garde ses outils irréversibles', async () => {
    // Rien ne distingue un risque dérivé d'un risque monté par le client à la création : le ramener au plancher
    // désarmerait une garde que quelqu'un a voulue. L'aller-retour part de `read`, pour que l'état attendu ne soit
    // pas celui de départ : sans le correctif, l'outil ne l'aurait jamais quitté.
    const r = await requete('lire effacer lire', 'GET');
    const o = await outil(r, 'lire_effacer_lire', 'read');
    await requetes.patch(tenantId, r, { methode: 'DELETE' });
    await requetes.patch(tenantId, r, { methode: 'GET' });
    expect(await risque(o)).toBe('irreversible');
  });

  it('🔴 seuls les outils de la requête modifiée bougent', async () => {
    const visee = await requete('visee', 'GET');
    const voisine = await requete('voisine', 'GET');
    const oVise = await outil(visee, 'outil_vise', 'read');
    const oVoisin = await outil(voisine, 'outil_voisin', 'read');
    await requetes.patch(tenantId, visee, { methode: 'DELETE' });
    expect(await risque(oVise)).toBe('irreversible');
    expect(await risque(oVoisin)).toBe('read');
  });
});
