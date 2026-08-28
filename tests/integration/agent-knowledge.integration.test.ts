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

/**
 * L'ÉCRITURE de la base de connaissance (tranche 19b) : ce que l'écran de réglage fait à la table.
 *
 * 🔴 Pourquoi ces cas ne peuvent PAS être prouvés par un double de test. Trois d'entre eux ne sont vrais que
 * si Postgres se comporte comme on le croit : l'appartenance de l'agent vérifiée DANS l'écriture
 * (`where exists`), le remplacement d'une source en une seule instruction (CTE modifiantes), et le fait
 * qu'un identifiant d'un autre tenant ne touche RIEN. Un faux store dirait oui à tout.
 */
describe.skipIf(!url)('écriture de la base de connaissance (Postgres)', () => {
  let pool: Pool;
  let store: PgKnowledgeStore;
  let tenantId: string;
  let autreTenantId: string;
  let agentId: string;
  let agentDeLAutre: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgKnowledgeStore(pool);
    const t = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-kb-write') returning id`);
    tenantId = t.rows[0]!.id;
    const t2 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-kb-write-autre') returning id`);
    autreTenantId = t2.rows[0]!.id;
    const a = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-w', 'Je suis une IA.', 'm') returning id`,
      [tenantId],
    );
    agentId = a.rows[0]!.id;
    const b = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest-w-autre', 'Je suis une IA.', 'm') returning id`,
      [autreTenantId],
    );
    agentDeLAutre = b.rows[0]!.id;
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('crée, liste, corrige et supprime une fiche', async () => {
    const creee = await store.creer(tenantId, agentId, { titre: 'Le linge', corps: 'Draps et serviettes fournis.' });
    expect(creee).not.toBeNull();
    expect(creee!.sourceUrl).toBeNull();
    // Une fiche écrite à la main n'a pas de date de lecture : il n'y a rien eu à relire.
    expect(creee!.derniereLectureAt).toBeNull();

    expect((await store.lister(tenantId, agentId)).map((f) => f.titre)).toEqual(['Le linge']);

    const corrigee = await store.modifier(tenantId, agentId, creee!.id, { corps: 'Draps fournis, serviettes en option.' });
    expect(corrigee!.corps).toContain('en option');
    expect(corrigee!.titre).toBe('Le linge'); // un patch partiel n'efface pas ce qu'il ne mentionne pas

    expect(await store.supprimer(tenantId, agentId, creee!.id)).toBe(true);
    expect(await store.lister(tenantId, agentId)).toEqual([]);
  });

  it('🔴 un agent d’un AUTRE tenant ne peut pas recevoir de fiche, et rien n’est écrit', async () => {
    // Le couple (tenant, agent) est ce qui rend une fiche visible : une ligne portant le tenant de l'un et
    // l'agent de l'autre ne serait jamais lue par personne, tout en occupant la place.
    expect(await store.creer(tenantId, agentDeLAutre, { titre: 'X', corps: 'Y' })).toBeNull();
    const compte = await pool.query<{ n: string }>('select count(*) as n from agent_knowledge where agent_id = $1', [agentDeLAutre]);
    expect(Number(compte.rows[0]!.n)).toBe(0);
  });

  it('🔴 un AUTRE tenant ne peut ni lire, ni corriger, ni supprimer une fiche', async () => {
    const mienne = await store.creer(tenantId, agentId, { titre: 'Les clés', corps: 'Remise des clés à l accueil.' });
    expect(await store.lister(autreTenantId, agentId)).toEqual([]);
    expect(await store.modifier(autreTenantId, agentId, mienne!.id, { titre: 'Détournée' })).toBeNull();
    expect(await store.supprimer(autreTenantId, agentId, mienne!.id)).toBe(false);
    // Et la fiche est intacte : un refus qui aurait quand même écrit ne serait pas un refus.
    const apres = await store.lister(tenantId, agentId);
    expect(apres.map((f) => f.titre)).toEqual(['Les clés']);
    await store.supprimer(tenantId, agentId, mienne!.id);
  });

  it('🔴 relire une source REMPLACE ses fiches au lieu de les dupliquer', async () => {
    const source = 'https://exemple.test/residence';
    const un = await store.remplacerSource(tenantId, agentId, source, [
      { titre: 'La piscine', corps: 'Ouverte de 9 h à 20 h.' },
      { titre: 'Le parking', corps: 'Gratuit pour les résidents.' },
    ]);
    expect(un).toEqual({ retirees: 0, ecrites: 2 });

    const deux = await store.remplacerSource(tenantId, agentId, source, [{ titre: 'La piscine', corps: 'Ouverte de 8 h à 21 h.' }]);
    expect(deux).toEqual({ retirees: 2, ecrites: 1 });

    const fiches = await store.lister(tenantId, agentId);
    expect(fiches).toHaveLength(1);
    expect(fiches[0]!.corps).toContain('8 h à 21 h');
    expect(fiches[0]!.sourceUrl).toBe(source);
    // La date de lecture est posée par l'import : c'est elle que l'écran montre pour signaler un contenu périmé.
    expect(fiches[0]!.derniereLectureAt).not.toBeNull();
    await store.supprimer(tenantId, agentId, fiches[0]!.id);
  });

  it('une relecture ne touche QUE la source relue', async () => {
    await store.remplacerSource(tenantId, agentId, 'https://exemple.test/a', [{ titre: 'A', corps: 'Contenu A.' }]);
    await store.remplacerSource(tenantId, agentId, 'https://exemple.test/b', [{ titre: 'B', corps: 'Contenu B.' }]);
    const main = await store.creer(tenantId, agentId, { titre: 'Écrite à la main', corps: 'Sans source.' });

    await store.remplacerSource(tenantId, agentId, 'https://exemple.test/a', [{ titre: 'A2', corps: 'Contenu A revu.' }]);
    const titres = (await store.lister(tenantId, agentId)).map((f) => f.titre).sort();
    expect(titres).toEqual(['A2', 'B', 'Écrite à la main']);
    expect(main).not.toBeNull();
  });

  it('🔴 relire pour un agent d’un autre tenant ne retire ni n’écrit rien', async () => {
    expect(await store.remplacerSource(tenantId, agentDeLAutre, 'https://exemple.test/x', [{ titre: 'X', corps: 'Y' }])).toBeNull();
    const compte = await pool.query<{ n: string }>('select count(*) as n from agent_knowledge where agent_id = $1', [agentDeLAutre]);
    expect(Number(compte.rows[0]!.n)).toBe(0);
  });
});
