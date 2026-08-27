import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgKnowledgeStore } from '../../src/agent/knowledge.pg';
import { ficheEstPertinente } from '../../src/agent/knowledge';

const url = process.env.DATABASE_URL ?? '';

/**
 * La recherche dans la base de connaissance, et surtout : la base produit-elle des mesures capables de
 * DÉCLENCHER la règle de pertinence ?
 *
 * 🔴 C'est la leçon de la revue de cette tâche. La première version comparait un rang `ts_rank_cd` à un
 * seuil, et ce seuil était INERTE : le rang a un plancher arithmétique au-dessus du seuil, donc aucune ligne
 * rendue ne pouvait tomber en dessous. Les tests unitaires ne pouvaient pas le voir puisqu'ils fabriquaient
 * le score. La preuve qu'une garde tient ne peut venir que d'ici, contre un vrai Postgres, avec un corpus
 * qui ressemble à une vraie base de connaissance.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('recherche dans la base de connaissance (Postgres)', () => {
  let pool: Pool;
  let store: PgKnowledgeStore;
  let tenantId: string;
  let autreTenantId: string;
  let agentId: string;
  let autreAgentId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgKnowledgeStore(pool);

    const t = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-kb') returning id`);
    tenantId = t.rows[0]!.id;
    const t2 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-kb-autre') returning id`);
    autreTenantId = t2.rows[0]!.id;

    const a = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-kb', 'Je suis une IA.', 'm') returning id`,
      [tenantId],
    );
    agentId = a.rows[0]!.id;
    const a2 = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-kb-2', 'Je suis une IA.', 'm') returning id`,
      [tenantId],
    );
    autreAgentId = a2.rows[0]!.id;

    // Un corpus qui ressemble à une vraie base de connaissance : des fiches écrites pour des clients, pas
    // taillées pour faire passer les assertions.
    const fiches: Array<[string, string]> = [
      ['La piscine', 'Horaires de la piscine : la piscine chauffee est ouverte tous les jours de 9 h a 20 h, bonnet obligatoire.'],
      ['Le parking', 'Le parking souterrain est gratuit pour les residents, une place par appartement.'],
      ['Les animaux', 'Les chiens sont acceptes dans les residences, moyennant un supplement de 8 euros par nuit.'],
    ];
    for (const [titre, corps] of fiches) {
      await pool.query(
        `insert into agent_knowledge (tenant_id, agent_id, titre, corps, source_url)
         values ($1, $2, $3, $4, 'https://exemple.test/fiche')`,
        [tenantId, agentId, titre, corps],
      );
    }
    // La MÊME fiche chez un autre agent du même tenant : c'est le cas que `agent_id` doit trancher.
    await pool.query(
      `insert into agent_knowledge (tenant_id, agent_id, titre, corps) values ($1, $2, 'La piscine', 'contenu de l autre agent')`,
      [tenantId, autreAgentId],
    );
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('une question couverte classe la bonne fiche en tête, et elle est jugée pertinente', async () => {
    const r = await store.chercher(tenantId, agentId, 'quels sont les horaires de la piscine', 3);
    expect(r[0]?.titre).toBe('La piscine');
    expect(r[0]?.termesTrouves).toBeGreaterThanOrEqual(2);
    expect(ficheEstPertinente(r[0]!)).toBe(true);
  });

  it('🔴 une question HORS SUJET ne rend RIEN : c est ce zéro qui porte la garantie', async () => {
    const r = await store.chercher(tenantId, agentId, 'quelle est la capitale de la Mongolie', 3);
    expect(r).toEqual([]);
  });

  it('🔴 UN MOT INCIDENT PARTAGÉ ne fait pas une source : la mesure tombe SOUS la règle', async () => {
    // LE test de la tâche, et celui que la première version ne pouvait pas passer. La fiche « parking »
    // partage « residents » avec la question, rien de plus. Elle remonte (le `where` est un OR), et c'est la
    // RÈGLE qui doit l'écarter. Si les mesures de la base ne pouvaient jamais tomber sous la règle, cette
    // assertion serait rouge, et c'est précisément ce qu'on veut pouvoir voir.
    const r = await store.chercher(tenantId, agentId, 'je suis resident depuis deux ans, je peux annuler ma reservation', 3);
    const parking = r.find((f) => f.titre === 'Le parking');
    expect(parking).toBeDefined();
    expect(parking!.termesTrouves).toBe(1);
    expect(parking!.couverture).toBeLessThan(0.5);
    expect(ficheEstPertinente(parking!)).toBe(false);
    // Et donc, au total, aucune source pour cette question.
    expect(r.filter(ficheEstPertinente)).toEqual([]);
  });

  it('une question courte qui tape le sujet est couverte à 100 pour cent', async () => {
    const r = await store.chercher(tenantId, agentId, 'piscine', 3);
    const piscine = r.find((f) => f.titre === 'La piscine');
    expect(piscine?.couverture).toBe(1);
    expect(ficheEstPertinente(piscine!)).toBe(true);
  });

  it('🔴 une FAUTE DE FRAPPE est rattrapée par le trigramme du titre, pas par le plein texte', async () => {
    // « parkin » n'est un lexème d'aucun document : le plein texte ne peut pas le trouver. Retirer la branche
    // trigramme du `where` rend donc ce test rouge, ce que l'ancienne version (requête « parking », que le
    // plein texte satisfaisait déjà) ne faisait pas.
    const r = await store.chercher(tenantId, agentId, 'parkin', 3);
    const parking = r.find((f) => f.titre === 'Le parking');
    expect(parking).toBeDefined();
    expect(parking!.termesTrouves).toBe(0); // le plein texte n'y est pour rien
    expect(parking!.proximiteTitre).toBeGreaterThanOrEqual(0.3);
    expect(ficheEstPertinente(parking!)).toBe(true);
  });

  it('les accents et la casse ne font pas rater une fiche', async () => {
    const r = await store.chercher(tenantId, agentId, 'PISCINE CHAUFFÉE', 3);
    expect(r.map((f) => f.titre)).toContain('La piscine');
  });

  it('🔴 un AUTRE tenant, ou un AUTRE agent, ne voit pas ces fiches', async () => {
    expect(await store.chercher(autreTenantId, agentId, 'piscine', 3)).toEqual([]);
    const autre = await store.chercher(tenantId, autreAgentId, 'piscine', 3);
    expect(autre.map((f) => f.corps)).toEqual(['contenu de l autre agent']);
  });

  it('une requête sans terme exploitable ne lance aucune requête et ne lève pas', async () => {
    // `to_tsquery` sur une chaîne vide lèverait : le découpage en code s'arrête avant.
    expect(await store.chercher(tenantId, agentId, '?!...', 3)).toEqual([]);
    expect(await store.chercher(tenantId, agentId, '', 3)).toEqual([]);
  });

  it('une question faite UNIQUEMENT de mots vides ne rend aucune source', async () => {
    // Les termes existent, donc la requête PART, mais `numnode(...) > 0` les écarte tous : aucun lexème,
    // aucune correspondance, et une couverture qui vaut zéro par construction.
    const r = await store.chercher(tenantId, agentId, 'et le la des ou donc', 3);
    expect(r.filter(ficheEstPertinente)).toEqual([]);
  });

  it('🔴 les métacaractères de tsquery ne font pas échouer la recherche', async () => {
    // La requête vient du modèle. Un `&` ou un `!` qui atteindrait `to_tsquery` ferait lever la requête,
    // donc échouer TOUTE recherche, donc sortir par `sans_source` en permanence.
    const r = await store.chercher(tenantId, agentId, "piscine & parking | !(chambre) : tarif * 'vue'", 3);
    expect(r.map((f) => f.titre).sort()).toEqual(['La piscine', 'Le parking']);
  });

  it('la limite est respectée', async () => {
    const r = await store.chercher(tenantId, agentId, 'piscine parking animaux residences', 1);
    expect(r).toHaveLength(1);
  });
});
