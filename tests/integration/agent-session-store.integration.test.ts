import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgAgentSessionStore } from '../../src/agent/session-store.pg';

const url = process.env.DATABASE_URL ?? '';

/**
 * Ce store ne fait que du SQL : sa seule preuve honnête est de tourner contre un vrai Postgres. Ce fichier
 * n'est JAMAIS joué par `npm test` (vitest.config.ts exclut tests/integration/**) ni en local (le
 * DATABASE_URL local pointe la PRODUCTION) : il est joué par le job `integration` de la CI, sur un Postgres
 * jetable.
 *
 * Ce qu'il verrouille : le verrou optimiste (un job pg-boss rejoué ne doit pas jouer deux fois le même tour),
 * l'unicité d'une session vivante par parcours (index partiel en base, pas une convention), et l'isolation
 * par tenant (le pooler est superuser, la RLS est bypassée, le filtrage en code est le seul contrôle).
 */
describe.skipIf(!url)('PgAgentSessionStore (Postgres)', () => {
  let pool: Pool;
  let store: PgAgentSessionStore;
  let tenantId: string;
  let autreTenantId: string;
  let workflowId: string;
  let agentId: string;

  const nouveauRun = async (): Promise<string> => {
    const r = await pool.query<{ id: string }>(
      `insert into workflow_runs (workflow_id, tenant_id, wa_id, status) values ($1, $2, '33600000000', 'waiting') returning id`,
      [workflowId, tenantId],
    );
    return r.rows[0]!.id;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 4 });
    store = new PgAgentSessionStore(pool);
    const t = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-sessions') returning id`);
    tenantId = t.rows[0]!.id;
    const t2 = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-agent-sessions-autre') returning id`);
    autreTenantId = t2.rows[0]!.id;
    const w = await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-agent') returning id`,
      [tenantId],
    );
    workflowId = w.rows[0]!.id;
    const a = await pool.query<{ id: string }>(
      `insert into agents (tenant_id, label, mention_ia, modele) values ($1, 'itest', 'Je suis une IA.', 'modele-test') returning id`,
      [tenantId],
    );
    agentId = a.rows[0]!.id;
  });

  afterAll(async () => {
    // Le cascade des tenants emporte workflows, runs, agents et sessions.
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    if (autreTenantId) await pool.query('delete from tenants where id = $1', [autreTenantId]);
    await pool.end();
  });

  it('open puis byRun rend la session, avec ses compteurs à zéro', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    expect(s.tours).toBe(0);
    expect(s.appelsOutils).toBe(0);
    expect(s.coutMicroEur).toBe(0);
    expect(typeof s.coutMicroEur).toBe('number'); // et non un BigInt, que JSON.stringify refuserait
    expect(s.status).toBe('en_cours');

    const relu = await store.byRun(tenantId, runId);
    expect(relu?.id).toBe(s.id);
  });

  it('byRun avec un AUTRE tenant rend null (isolation)', async () => {
    const runId = await nouveauRun();
    await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    expect(await store.byRun(autreTenantId, runId)).toBeNull();
  });

  it('🔴 prendreLeTour rend null au SECOND appel avec le même numéro de tour (rejeu neutralisé)', async () => {
    // pg-boss est at-least-once. Sans ce verrou, un job rejoué enverrait un second message WhatsApp et
    // rappellerait les outils.
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });

    const premier = await store.prendreLeTour(tenantId, s.id, 0);
    expect(premier?.tours).toBe(1);

    const rejeu = await store.prendreLeTour(tenantId, s.id, 0);
    expect(rejeu).toBeNull();

    // Le tour suivant, lui, passe : le verrou bloque le rejeu, pas la progression.
    const suivant = await store.prendreLeTour(tenantId, s.id, 1);
    expect(suivant?.tours).toBe(2);
  });

  it('🔴 prendreLeTour rend null avec un AUTRE tenant (isolation, le pooler est superuser)', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    expect(await store.prendreLeTour(autreTenantId, s.id, 0)).toBeNull();
    // et le compteur n'a pas bougé
    expect((await store.byRun(tenantId, runId))?.tours).toBe(0);
  });

  it('prendreLeTour rend null sur une session CLOSE', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    await store.clore(tenantId, s.id, 'sortie', 'sortie:fini');
    expect(await store.prendreLeTour(tenantId, s.id, 0)).toBeNull();
  });

  it('🔴 une seule session VIVANTE par parcours (index partiel en base)', async () => {
    const runId = await nouveauRun();
    await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    await expect(store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' })).rejects.toThrow();
  });

  it('clore libère le parcours : byRun ne la voit plus, et un nouvel open redevient possible', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    await store.clore(tenantId, s.id, 'inactivite');
    expect(await store.byRun(tenantId, runId)).toBeNull();
    const seconde = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    expect(seconde.id).not.toBe(s.id);
  });

  it('clore n écrase pas la cause d une session DÉJÀ close (un rejeu ne transforme pas une sortie en erreur)', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    await store.clore(tenantId, s.id, 'sortie', 'sortie:fini');
    await store.clore(tenantId, s.id, 'erreur');
    const r = await pool.query<{ status: string; sortie: string | null }>(
      'select status, sortie from agent_sessions where id = $1',
      [s.id],
    );
    expect(r.rows[0]?.status).toBe('sortie');
    expect(r.rows[0]?.sortie).toBe('sortie:fini');
  });

  it('ajouterAuTranscript empile, et n écrase pas l entrée précédente', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    await store.ajouterAuTranscript(tenantId, s.id, { role: 'contact', texte: 'bonjour' });
    await store.ajouterAuTranscript(tenantId, s.id, { role: 'agent', texte: 'bonjour, en quoi puis-je aider ?' });
    const r = await pool.query<{ transcript: Array<{ role: string }> }>(
      'select transcript from agent_sessions where id = $1',
      [s.id],
    );
    expect(r.rows[0]?.transcript.map((e) => e.role)).toEqual(['contact', 'agent']);
  });

  it('ajouterAuTranscript avec un AUTRE tenant n écrit rien (isolation)', async () => {
    const runId = await nouveauRun();
    const s = await store.open({ tenantId, runId, agentId, nodeId: 'n1', waId: '33600000000' });
    await store.ajouterAuTranscript(autreTenantId, s.id, { role: 'contact', texte: 'injection' });
    const r = await pool.query<{ transcript: unknown[] }>('select transcript from agent_sessions where id = $1', [s.id]);
    expect(r.rows[0]?.transcript).toEqual([]);
  });

  /**
   * LA MARQUE DE TOUR EN VOL, ET LA TRANSITION TERMINALE (contre-audit du 2026-09-03).
   *
   * 🔴 POURQUOI CES TESTS SONT ICI ET PAS EN UNITAIRE. Le correctif tient entièrement dans du SQL : un `case`
   * qui conserve ou efface une colonne, un prédicat de réclamation dont on a RETIRÉ la condition de statut, et
   * deux gardes miroir (`status = 'en_cours'` d'un côté, `status <> 'en_cours'` de l'autre) qui empêchent deux
   * chemins concurrents d'effacer la marque l'un de l'autre. Rien de tout ça n'est visible d'un faux store.
   *
   * Et cette requête de réclamation n'avait AUCUNE couverture avant ce lot, alors que c'est elle qui décide
   * si un parcours bloqué est retrouvé ou perdu pour toujours.
   */
  const enVolDepuis = async (sessionId: string, secondes: number): Promise<void> => {
    await pool.query(
      'update agent_sessions set tour_commence_le = now() - make_interval(secs => $2::int) where id = $1',
      [sessionId, secondes],
    );
  };
  const marque = async (sessionId: string): Promise<Date | null> => {
    const r = await pool.query<{ tour_commence_le: Date | null }>(
      'select tour_commence_le from agent_sessions where id = $1',
      [sessionId],
    );
    return r.rows[0]?.tour_commence_le ?? null;
  };
  const session = async () => {
    const s = await store.open({ tenantId, runId: await nouveauRun(), agentId, nodeId: 'n1', waId: '33600000000' });
    await store.prendreLeTour(tenantId, s.id, s.tours);
    return s;
  };

  it('🔴 clore SANS sortie due efface la marque, clore AVEC sortie due la garde', async () => {
    const s1 = await session();
    await store.clore(tenantId, s1.id, 'sortie', 'sortie:fini');
    expect(await marque(s1.id), 'aucune sortie due : il ne reste rien à faire').toBeNull();

    const s2 = await session();
    await store.clore(tenantId, s2.id, 'sortie', 'sortie:fini', { sortieDue: true });
    expect(await marque(s2.id), 'la sortie reste due : la marque désigne le travail restant').not.toBeNull();
  });

  it('🔴 la réclamation ramasse AUSSI une session déjà close dont la sortie est restée due', async () => {
    // Le cas exact du défaut : runTurn a clos, puis est mort avant de faire sortir le parcours. Avant ce
    // correctif la ligne n'était plus `en_cours` et n'avait plus de marque, donc elle était introuvable.
    const s = await session();
    await store.clore(tenantId, s.id, 'erreur', 'sortie:echec', { sortieDue: true });
    await enVolDepuis(s.id, 900);
    const tours = await store.reclamerToursBloques(600, 10, 'sortie:balayage');
    expect(tours.map((t) => t.sessionId)).toContain(s.id);
    // Et la cause de fin d'une session DÉJÀ close ne doit pas être réécrite au passage.
    const r = await pool.query<{ sortie: string | null }>('select sortie from agent_sessions where id = $1', [s.id]);
    expect(r.rows[0]?.sortie).toBe('sortie:echec');
  });

  it('🔴 la réclamation POSE UN BAIL : la marque est repoussée, pas effacée', async () => {
    const s = await session();
    await enVolDepuis(s.id, 900);
    const tours = await store.reclamerToursBloques(600, 10, 'sortie:balayage');
    expect(tours.map((t) => t.sessionId)).toContain(s.id);
    expect(await marque(s.id), 'la marque tient tant que la sortie n’est pas appliquée').not.toBeNull();
    // Une session encore `en_cours` est bien close par la réclamation, elle.
    const r = await pool.query<{ status: string }>('select status from agent_sessions where id = $1', [s.id]);
    expect(r.rows[0]?.status).toBe('erreur');
    // Et le bail tient : un second passage immédiat ne reprend pas la même ligne.
    const deuxieme = await store.reclamerToursBloques(600, 10, 'sortie:balayage');
    expect(deuxieme.map((t) => t.sessionId)).not.toContain(s.id);
  });

  it('🔴 sortieAppliquee efface la marque, et la ligne cesse d’être réclamable', async () => {
    const s = await session();
    await store.clore(tenantId, s.id, 'erreur', 'sortie:echec', { sortieDue: true });
    await enVolDepuis(s.id, 900);
    await store.sortieAppliquee(tenantId, s.id);
    expect(await marque(s.id)).toBeNull();
    expect((await store.reclamerToursBloques(600, 10, 'sortie:balayage')).map((t) => t.sessionId)).not.toContain(s.id);
  });

  it('🔴 les deux gardes MIROIR : chaque effaceur ne touche que son état', async () => {
    // C'est ce qui empêche un tour périmé d'effacer la marque posée par le balayage qui a repris sa session,
    // et symétriquement un balayage d'effacer celle d'un tour bien vivant.
    const vivante = await session();
    await store.sortieAppliquee(tenantId, vivante.id);
    expect(await marque(vivante.id), 'sortieAppliquee ne touche pas une session vivante').not.toBeNull();

    const close = await session();
    await store.clore(tenantId, close.id, 'erreur', 'sortie:echec', { sortieDue: true });
    await store.finirLeTour(tenantId, close.id);
    expect(await marque(close.id), 'finirLeTour ne touche pas une session close').not.toBeNull();
  });

  it('la marque ne franchit pas la frontière du tenant', async () => {
    const s = await session();
    await store.clore(tenantId, s.id, 'erreur', 'sortie:echec', { sortieDue: true });
    await store.sortieAppliquee(autreTenantId, s.id);
    expect(await marque(s.id)).not.toBeNull();
  });

  /**
   * LE COMPTAGE DES MESSAGES D'UN AGENT (tâche 4 du plan « refactor-ecrans-agents »).
   *
   * `conversation_messages` n'a pas de `tenant_id` et `agent_sessions` n'a pas de `conversation_id` : le
   * rapprochement se fait par `wa_id`, à l'intérieur du tenant. Les conversations et leurs messages sont
   * insérés par SQL direct, comme le reste de ce fichier fait pour les tables que le store ne gère pas.
   */
  it('🔴 messagesTenus compte les DEUX sens, et EXCLUT les fils de test', async () => {
    // Deux conversations : une tenue par l'agent (2 messages, un dans chaque sens), une de TEST tenue par
    // le même agent (1 message). Le compte doit valoir 2 et pas 3.
    // Et une troisième conversation du même espace que l'agent n'a jamais tenue (1 message) : elle ne doit
    // pas entrer non plus, sinon la mesure compterait tout l'espace au lieu de cet agent.
    const waTenue = '33650000001';
    const waTest = '33650000002';
    const waEtrangere = '33650000003';
    await store.open({ tenantId, runId: await nouveauRun(), agentId, nodeId: 'n1', waId: waTenue });
    await store.open({ tenantId, runId: await nouveauRun(), agentId, nodeId: 'n1', waId: waTest });

    const conv = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, is_test) values ($1, $2, false) returning id`,
      [tenantId, waTenue],
    );
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, body) values ($1, 'in', 'bonjour'), ($1, 'out', 'bonjour, en quoi puis-je aider')`,
      [conv.rows[0]!.id],
    );

    const convTest = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, is_test) values ($1, $2, true) returning id`,
      [tenantId, waTest],
    );
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, body) values ($1, 'in', 'essai depuis le scenario')`,
      [convTest.rows[0]!.id],
    );

    const convEtrangere = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, is_test) values ($1, $2, false) returning id`,
      [tenantId, waEtrangere],
    );
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, body) values ($1, 'in', 'un autre client')`,
      [convEtrangere.rows[0]!.id],
    );

    const n = await store.messagesTenus(tenantId, agentId, 30);
    expect(n).toBe(2);
  });

  /**
   * 🔴 LE CAS PRÉCÉDENT NE PROUVAIT RIEN SUR `c.tenant_id = $1` (relevé en revue). `agentId` n'a de sessions
   * que sous `tenantId` : appelé avec `autreTenantId`, le sous-select sur `agent_sessions` rend un ensemble
   * VIDE de `wa_id`, et un `in (vide)` rend 0 QUE LE FILTRE DE LA REQUÊTE EXTERNE (`c.tenant_id = $1`) SOIT
   * LÀ OU NON. Un test qui se contente d'appeler `messagesTenus(autreTenantId, ...)` reste donc vert même si
   * ce filtre disparaît un jour, alors que c'est le SEUL contrôle d'isolation de `conversation_messages`
   * (cette table n'a pas de `tenant_id` à elle, migration 0009).
   *
   * Pour que le test TOMBE si ce filtre disparaît, il faut une conversation qui PARTAGE le même `wa_id`
   * qu'une conversation tenue par l'agent, mais chez un AUTRE tenant : le sous-select (borné par tenant) la
   * désignera quand même, via son `wa_id`, et seule la jointure filtrée sur `c.tenant_id` empêche ses
   * messages d'entrer dans le compte de `tenantId`. L'unique de `conversations` porte sur `(tenant_id,
   * wa_id)`, jamais sur `wa_id` seul, donc cette ligne est parfaitement légale en base.
   */
  it('🔴 un doublon de wa_id chez un AUTRE tenant ne fuit pas dans le compte', async () => {
    // ⚠️ COMPARÉ EN DELTA, PAS EN VALEUR ABSOLUE. Ce fichier ne nettoie qu'à `afterAll` (cascade du tenant) :
    // le cas précédent laisse déjà une conversation `tenue` avec 2 messages sous ce même `tenantId`/`agentId`,
    // et le compte absolu dépendrait donc de l'ORDRE d'exécution des tests, pas seulement du SQL qu'on teste.
    // « avant » capture l'état une fois CETTE conversation posée, et la seule chose qui doit changer ensuite
    // est l'ajout du doublon chez l'autre tenant.
    const wa = '33650000004';
    await store.open({ tenantId, runId: await nouveauRun(), agentId, nodeId: 'n1', waId: wa });

    const conv = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, is_test) values ($1, $2, false) returning id`,
      [tenantId, wa],
    );
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, body) values ($1, 'in', 'bonjour'), ($1, 'out', 'bonjour, en quoi puis-je aider')`,
      [conv.rows[0]!.id],
    );

    const avant = await store.messagesTenus(tenantId, agentId, 30);

    // Même wa_id, chez l'AUTRE tenant, avec ses propres messages : c'est cette conversation-là que le
    // sous-select retrouverait si `c.tenant_id = $1` disparaissait de la requête externe.
    const fuite = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, wa_id, is_test) values ($1, $2, false) returning id`,
      [autreTenantId, wa],
    );
    await pool.query(
      `insert into conversation_messages (conversation_id, direction, body) values ($1, 'in', 'fuite'), ($1, 'out', 'fuite aussi')`,
      [fuite.rows[0]!.id],
    );

    // Le doublon ne doit RIEN ajouter : sans `c.tenant_id = $1`, la jointure retrouverait AUSSI ses 2
    // messages, et ce total augmenterait de 2 au lieu de rester identique.
    expect(await store.messagesTenus(tenantId, agentId, 30)).toBe(avant);
    // Et l'autre sens rend bien 0 : le sous-select est déjà borné par tenant. Ce cas-là reste, mais seul il
    // ne dirait rien si `c.tenant_id = $1` disparaissait (cf. commentaire au-dessus du test).
    expect(await store.messagesTenus(autreTenantId, agentId, 30)).toBe(0);
  });
});
