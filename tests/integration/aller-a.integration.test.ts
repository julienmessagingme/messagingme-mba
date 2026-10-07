import '../../src/charger-env';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgWorkflowStore } from '../../src/workflow/store.pg';
import { PgWorkflowRunStore } from '../../src/workflow/run-store.pg';
import { PgErreursLivraisonStore } from '../../src/ops/erreurs-livraison.pg';
import { buildWorkflowRuntime } from '../../src/workflow/wiring';
import type { WorkflowExecutorDeps } from '../../src/workflow/executor';
import type { WorkflowGraph } from '../../src/workflow/graph';
import { offresToutOuvert } from '../gardes';

const url = process.env.DATABASE_URL ?? '';

/**
 * LE BLOC « ALLER À » CONTRE UNE VRAIE BASE (RC5, livraison B).
 *
 * 🔴 EN INTÉGRATION parce que ce qui compte ici est ce que le VRAI câblage lit et écrit : la cible d'un saut se résout
 * sur les graphes PUBLIÉS des scénarios de l'espace (`resoudreBloc`, par `PgWorkflowStore.list`, scopé), un saut manqué
 * s'écrit dans le journal des échecs de scénario, et le parcours lu transporte sa fiche jusqu'au parcours d'arrivée. Un
 * faux dépôt prouverait ma lecture, pas la requête.
 *
 * Jamais joué en local (le DATABASE_URL local pointe la PRODUCTION), joué par le job `integration`.
 */
describe.skipIf(!url)('« Aller à » (Postgres)', () => {
  let pool: Pool;
  let tenantId = '';
  let autreTenant = '';
  let deps: WorkflowExecutorDeps;
  const wfStore = () => new PgWorkflowStore(pool);
  const code = (k: number): string => `nod_itest_01J${String(k).padStart(23, '0')}`;
  const graphe = (c: string, corps: string): WorkflowGraph => ({
    nodes: [{ id: 'x', type: 'quick_message', position: { x: 0, y: 0 }, data: { body: corps, code: c } }], edges: [],
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl(), max: 3 });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-aller-a') returning id`)).rows[0]!.id;
    autreTenant = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-aller-a-2') returning id`)).rows[0]!.id;
    const inerte = {} as never;
    const { executor } = buildWorkflowRuntime({
      pool, queue: { enqueue: async () => {} }, dryRun: true, repo: inerte, contactStore: inerte, inboxStore: inerte,
      settingsStore: inerte, workflowStore: wfStore(), metaCredentials: inerte, metaFactory: inerte, rcsProvider: 'fake',
      emailTemplates: inerte, emailResolver: inerte, numeroDeLEspace: async () => null, runStore: new PgWorkflowRunStore(pool), fil: inerte,
      offres: offresToutOuvert,
    });
    deps = Reflect.get(executor, 'deps') as WorkflowExecutorDeps;
  });

  afterAll(async () => {
    for (const t of [tenantId, autreTenant]) if (t) await pool.query('delete from tenants where id = $1', [t]).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('🔴 la cible se résout sur le graphe PUBLIÉ, et jamais dans un autre espace', async () => {
    const chezNous = await wfStore().insert(tenantId, 'Menu principal', graphe(code(1), 'Ici'));
    await wfStore().publish(chezNous.id, tenantId);
    const chezLeVoisin = await wfStore().insert(autreTenant, 'Voisin', graphe(code(2), 'Chez le voisin'));
    await wfStore().publish(chezLeVoisin.id, autreTenant);
    // Un bloc du seul brouillon : il n'est pas encore en ligne, aucun contact ne peut l'atteindre.
    const brouillon = await wfStore().insert(tenantId, 'Brouillon', graphe(code(3), 'Pas encore en ligne'));

    const ici = await deps.resoudreBloc(tenantId, code(1));
    expect(ici).toMatchObject({ workflowId: chezNous.id, nodeId: 'x' });
    expect(ici?.graph.nodes[0]?.data.body).toBe('Ici');
    expect(await deps.resoudreBloc(tenantId, code(2)), 'le code d’un autre espace est une cible inexistante').toBeNull();
    expect(await deps.resoudreBloc(autreTenant, code(2))).toMatchObject({ workflowId: chezLeVoisin.id });
    expect(await deps.resoudreBloc(tenantId, code(3)), 'un bloc du seul brouillon n’est pas une cible').toBeNull();
    expect(brouillon.id).toBeTruthy();
  });

  it('🔴 un saut manqué s’écrit dans le journal des échecs de scénario, au nom du scénario', async () => {
    const wf = await wfStore().insert(tenantId, 'Scénario qui saute', { nodes: [], edges: [] });
    await deps.journaliserEchecSaut({
      tenantId, waId: '33600000901', workflowId: wf.id, runId: null, messageId: 'wamid.901',
      erreur: 'le bloc « Vers le menu » vise un bloc qui n’existe plus',
    });
    const ligne = (await new PgErreursLivraisonStore(pool).lister(tenantId)).find((e) => e.telephone === '33600000901');
    expect(ligne).toMatchObject({ origine: 'scenario', campaignName: 'Scénario qui saute', message: 'le bloc « Vers le menu » vise un bloc qui n’existe plus' });
    // Et jamais chez le voisin.
    expect((await new PgErreursLivraisonStore(pool).lister(autreTenant)).some((e) => e.telephone === '33600000901')).toBe(false);
  });

  it('les deux lectures d’un parcours rendent sa fiche, que le saut transmet', async () => {
    const runs = new PgWorkflowRunStore(pool);
    const wf = await wfStore().insert(tenantId, 'Parcours avec fiche', { nodes: [], edges: [] });
    const contact = (await pool.query<{ id: string }>(
      `insert into contacts (tenant_id, phone_e164) values ($1, '+33600000902') returning id`, [tenantId],
    )).rows[0]!.id;
    const { id } = await runs.start(tenantId, wf.id, '33600000902', contact, { currentNode: 'q', status: 'waiting' }, null);
    expect((await runs.findWaitingByWaId(tenantId, '33600000902'))?.contactId).toBe(contact);
    expect((await runs.byId(tenantId, id))?.contactId).toBe(contact);
  });
});
