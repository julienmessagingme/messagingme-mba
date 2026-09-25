import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgWorkflowRunStore } from '../../src/workflow/run-store.pg';

/**
 * L'échéance « pas de réponse » d'un bloc Question, contre une VRAIE base (migration 0085).
 *
 * C'est du SQL, et le SQL ne se vérifie qu'en base. Trois invariants portent le mécanisme, et chacun se casse
 * en SILENCE s'il lâche :
 *
 *  - le run reste `waiting` avec une échéance : s'il basculait en `sleeping`, `findWaitingByWaId` ne le verrait
 *    plus et la RÉPONSE DU CONTACT serait perdue ;
 *  - la réclamation pose un BAIL (elle repousse l'échéance), donc une expiration n'est prise qu'une fois
 *    même avec plusieurs workers, ET une reprise ratée la retrouve au tour suivant. La détruire garantissait
 *    surtout de la perdre POUR TOUJOURS au premier refus de Meta ;
 *  - `claimDueSleeping` et `claimDueQuestions` ne se marchent pas dessus : chacune ne voit que sa famille.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('bloc Question : la réclamation de l’échéance', () => {
  let pool: Pool;
  let store: PgWorkflowRunStore;
  let tenantId: string;
  let workflowId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    store = new PgWorkflowRunStore(pool);
    tenantId = (await pool.query<{ id: string }>(
      `insert into tenants (name) values ('itest-question-timeout') returning id`,
    )).rows[0]!.id;
    workflowId = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name, graph) values ($1, 'itest', '{"nodes":[],"edges":[]}'::jsonb) returning id`,
      [tenantId],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    await pool.query(`delete from tenants where id = $1`, [tenantId]);
    await pool.end();
  });

  /** Crée un run par le CHEMIN RÉEL (`start`), puis force son échéance dans le passé. */
  async function runDu(waId: string, echeance: 'passee' | 'future' | 'aucune', status: 'waiting' | 'sleeping' = 'waiting'): Promise<string> {
    const { id } = await store.start(tenantId, workflowId, waId, null, { currentNode: 'q', status }, null);
    const quand = echeance === 'passee' ? "now() - interval '1 minute'" : echeance === 'future' ? "now() + interval '1 hour'" : 'null';
    await pool.query(`update workflow_runs set status = $2, resume_at = ${quand} where id = $1`, [id, status]);
    return id;
  }

  it('🔴 un run WAITING porte une échéance, et reste joignable par une réponse du contact', async () => {
    // C'est LE point d'architecture : la question attend les deux à la fois.
    const id = await runDu('33600000101', 'future');
    const lu = await store.findWaitingByWaId(tenantId, '33600000101');
    expect(lu?.id).toBe(id);
    expect(lu?.status).toBe('waiting');
    const r = await pool.query<{ resume_at: Date | null }>(`select resume_at from workflow_runs where id = $1`, [id]);
    expect(r.rows[0]?.resume_at).not.toBeNull();
  });

  it('🔴 réclame les échéances DUES une seule fois, par un BAIL et non en les détruisant', async () => {
    const id = await runDu('33600000102', 'passee');
    const premier = await store.claimDueQuestions(50);
    expect(premier.map((x) => x.id)).toContain(id);
    expect(premier.find((x) => x.id === id)?.status).toBe('waiting');
    // Deuxième passage immédiat : l'échéance est repoussée, la ligne n'est plus due. Exclusivité tenue.
    const second = await store.claimDueQuestions(50);
    expect(second.map((x) => x.id)).not.toContain(id);
    // 🔴 Mais elle EXISTE toujours, dans le futur : une reprise qui échoue (refus de Meta, worker
    // redéployé) la retrouve au bail suivant. La détruire ici perdait la sortie « pas de réponse » POUR
    // TOUJOURS, en laissant le fil tenu par un parcours mort que rien ne réveille.
    const r = await pool.query<{ status: string; resume_at: Date | null }>(`select status, resume_at from workflow_runs where id = $1`, [id]);
    expect(r.rows[0]?.status).toBe('waiting');
    expect(r.rows[0]?.resume_at).not.toBeNull();
    expect(r.rows[0]!.resume_at!.getTime()).toBeGreaterThan(Date.now());
    // Et le run reste joignable par une réponse du contact pendant toute la reprise : c'est le point qui
    // distingue cette réclamation de celle du sommeil.
    expect((await store.findWaitingByWaId(tenantId, '33600000102'))?.id).toBe(id);
  });

  it('ne réclame ni une échéance FUTURE, ni un run sans échéance', async () => {
    const futur = await runDu('33600000103', 'future');
    const sans = await runDu('33600000104', 'aucune');
    const pris = (await store.claimDueQuestions(50)).map((x) => x.id);
    expect(pris).not.toContain(futur);
    expect(pris).not.toContain(sans);
  });

  it('🔴 les deux réclamations ne se marchent pas dessus', async () => {
    // Un dormant pris par la réclamation des questions repartirait par la sortie `timeout` d'un bloc Attente
    // qui n'en a pas : le parcours mourrait en silence.
    const dormant = await runDu('33600000105', 'passee', 'sleeping');
    const question = await runDu('33600000106', 'passee', 'waiting');
    const parQuestion = (await store.claimDueQuestions(50)).map((x) => x.id);
    expect(parQuestion).toContain(question);
    expect(parQuestion).not.toContain(dormant);
    const parSommeil = (await store.claimDueSleeping(50)).map((x) => x.id);
    expect(parSommeil).toContain(dormant);
    expect(parSommeil).not.toContain(question);
  });

  it('l’index de la migration 0085 existe (sans lui, un balayage par minute scannerait toute la table)', async () => {
    const r = await pool.query(
      `select 1 from pg_indexes where tablename = 'workflow_runs' and indexname = 'workflow_runs_question_timeout_idx'`,
    );
    expect(r.rowCount).toBe(1);
  });

  it('🔴 setStateSiEncoreSur n ecrit RIEN quand le run a bouge', async () => {
    // La garde qui empêche un tour d'agent de RESSUSCITER un run tué pendant qu'il réfléchissait. Sans elle,
    // le run reviendrait `waiting` avec une échéance : invisible de `findWaitingByWaId` (un run plus récent
    // existe) mais parfaitement visible du balayeur, qui déclencherait plus tard la branche « pas de
    // réponse » d'un parcours que quelqu'un avait délibérément fermé.
    const id = await runDu('33600000108', 'aucune');
    const lu = await pool.query<{ current_node: string }>('select current_node from workflow_runs where id = $1', [id]);
    const courant = lu.rows[0]!.current_node;
    const etat = { currentNode: courant, status: 'waiting' as const, resumeAt: new Date(Date.now() + 60_000) };
    // Le run est encore là où on le croit : l'écriture passe.
    expect(await store.setStateSiEncoreSur(tenantId, id, courant, etat)).toBe(true);

    // Puis le run est tué, comme le ferait un opérateur qui lance un scénario depuis l'Inbox.
    await store.setState(id, { currentNode: null, status: 'done' });
    expect(await store.setStateSiEncoreSur(tenantId, id, courant, etat)).toBe(false);
    const apres = await pool.query<{ status: string; resume_at: Date | null }>(
      'select status, resume_at from workflow_runs where id = $1', [id],
    );
    expect(apres.rows[0]?.status).toBe('done');
    expect(apres.rows[0]?.resume_at).toBeNull();
  });

  it('🔴 setStateSiEncoreSur d un AUTRE tenant n ecrit rien (isolation)', async () => {
    const id = await runDu('33600000109', 'aucune');
    const lu = await pool.query<{ current_node: string }>('select current_node from workflow_runs where id = $1', [id]);
    const courant = lu.rows[0]!.current_node;
    const autre = await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-qt-autre') returning id`);
    const autreId = autre.rows[0]!.id;
    expect(await store.setStateSiEncoreSur(autreId, id, courant, { currentNode: courant, status: 'waiting' })).toBe(false);
    await pool.query('delete from tenants where id = $1', [autreId]);
  });

  it('répondre efface l’échéance : `setState` l’écrit SANS coalesce', async () => {
    // Sans ça, le balayeur réveillerait un parcours déjà reparti et enverrait la branche « pas de réponse »
    // à quelqu'un qui vient justement de répondre.
    const id = await runDu('33600000107', 'future');
    await store.setState(id, { currentNode: 'suite', status: 'waiting' });
    const r = await pool.query<{ resume_at: Date | null }>(`select resume_at from workflow_runs where id = $1`, [id]);
    expect(r.rows[0]?.resume_at).toBeNull();
  });
});
