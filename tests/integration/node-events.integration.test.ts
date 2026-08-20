import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { pgSsl } from '../../src/db/ssl';
import { PgWorkflowNodeEventStore } from '../../src/workflow/node-events.pg';

/**
 * Intégration du journal des événements par bloc. ISOLÉE par tenant jetable (créé/détruit ici).
 *
 * Écrit en base puis relit, jamais via un double : c'est la leçon de la purge du 2026-08-18, dont les tests à
 * faux store prouvaient l'appel et jamais l'effet.
 */
const url = process.env.DATABASE_URL ?? '';

describe.skipIf(!url)('mesures par bloc — écriture et agrégat', () => {
  let pool: Pool;
  let tenantId = '';
  let workflowId = '';
  let store: PgWorkflowNodeEventStore;
  /**
   * Fenêtre de lecture VOLONTAIREMENT large (hier -> demain), et non « aujourd'hui ».
   *
   * 🔴 Ce test a échoué en CI le 2026-08-21 à 00 h 05 heure de Paris, sans rapport avec le code testé : il
   * calculait « aujourd'hui » en Europe/Paris alors que `countByNode` compare `at >= $3::date` en UTC. Entre
   * minuit et 2 h du matin l'été, les deux ne désignent pas le même jour, et le filtre excluait tous les
   * événements qui venaient d'être insérés.
   *
   * Ce que ce test doit prouver, c'est l'AGRÉGATION (par bloc, par nature, par choix), pas la gestion des
   * fuseaux aux bornes de journée. Élargir la fenêtre retire cette variable sans rien retirer à ce qui est
   * vérifié : le tenant est jetable, donc rien d'autre ne peut se glisser dans le résultat. Que le filtre
   * borne en UTC alors que l'écran raisonne en heure locale reste un vrai sujet, suivi dans `todo.md`.
   */
  const jourDe = (decalage: number): string => new Date(Date.now() + decalage * 86_400_000).toISOString().slice(0, 10);
  const debut = jourDe(-1);
  const fin = jourDe(1);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, ssl: pgSsl() });
    tenantId = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mesures') returning id`)).rows[0]!.id;
    workflowId = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-mesures-wf') returning id`, [tenantId],
    )).rows[0]!.id;
    store = new PgWorkflowNodeEventStore(pool);

    const e = (nodeId: string, waId: string, kind: 'sent' | 'failed' | 'reply_button' | 'reply_text', handle?: string) =>
      store.record({ tenantId, workflowId, nodeId, waId, kind, ...(handle ? { handle } : {}) });

    // Bloc n1 : 3 envois, 1 echec. Deux contacts cliquent le choix 1, l'un d'eux DEUX fois. Un troisieme ecrit.
    await e('n1', '33600001', 'sent');
    await e('n1', '33600002', 'sent');
    await e('n1', '33600003', 'sent');
    await e('n1', '33600004', 'failed');
    await e('n1', '33600001', 'reply_button', 'btn:0');
    await e('n1', '33600001', 'reply_button', 'btn:0');
    await e('n1', '33600002', 'reply_button', 'btn:1');
    await e('n1', '33600003', 'reply_text');
    // Bloc n2 : un seul envoi, pour verifier que les blocs ne se melangent pas.
    await e('n2', '33600001', 'sent');
  });

  afterAll(async () => {
    if (tenantId) await pool.query('delete from tenants where id = $1', [tenantId]);
    await pool.end();
  });

  const lire = async (): Promise<Record<string, number>> => {
    const rows = await store.countByNode(tenantId, workflowId, { from: debut, to: fin });
    return Object.fromEntries(rows.map((r) => [`${r.nodeId}/${r.kind}${r.handle ? `/${r.handle}` : ''}`, r.count]));
  };

  it('🔴 agrège par bloc, par nature et par CHOIX', async () => {
    expect(await lire()).toMatchObject({
      'n1/sent': 3,
      'n1/failed': 1,
      'n1/reply_button/btn:0': 2,
      'n1/reply_button/btn:1': 1,
      'n1/reply_text': 1,
      'n2/sent': 1,
    });
  });

  it('🔴 « combien de clics » n’est pas « combien de personnes »', async () => {
    // Un contact qui clique deux fois compte deux clics et UNE personne. Confondre les deux fait surestimer
    // l'audience d'un choix, et c'est le genre de chiffre sur lequel on prend une decision.
    const rows = await store.countByNode(tenantId, workflowId, { from: debut, to: fin });
    const clic0 = rows.find((r) => r.nodeId === 'n1' && r.handle === 'btn:0')!;
    expect(clic0.count).toBe(2);
    expect(clic0.contacts).toBe(1);
  });

  it('une période qui ne couvre pas les événements rend une liste vide', async () => {
    expect(await store.countByNode(tenantId, workflowId, { from: '2020-01-01', to: '2020-01-02' })).toEqual([]);
  });

  it('🔴 isolation : un AUTRE espace ne voit rien de ces mesures', async () => {
    const autre = (await pool.query<{ id: string }>(`insert into tenants (name) values ('itest-mesures-autre') returning id`)).rows[0]!.id;
    try {
      expect(await store.countByNode(autre, workflowId, { from: debut, to: fin })).toEqual([]);
    } finally {
      await pool.query('delete from tenants where id = $1', [autre]);
    }
  });

  it('🔴 un accusé Meta retrouve le BLOC qui a envoyé le message', async () => {
    // Tout est dérivé de la ligne d'envoi : espace, scénario, bloc, destinataire. C'est ce qui rend
    // « combien lus » mesurable par bloc alors que les statuts Meta ne connaissent qu'un identifiant.
    await store.record({ tenantId, workflowId, nodeId: 'n9', waId: '33600010', kind: 'sent', metaMessageId: 'wamid.itest.1' });
    expect(await store.recordStatusForMessage('wamid.itest.1', 'read')).toBe(1);

    const ligne = (await pool.query<{ node_id: string; wa_id: string; workflow_id: string }>(
      `select node_id, wa_id, workflow_id from workflow_node_events where meta_message_id = $1 and kind = 'read'`,
      ['wamid.itest.1'],
    )).rows[0]!;
    expect(ligne).toMatchObject({ node_id: 'n9', wa_id: '33600010', workflow_id: workflowId });
  });

  it('🔴 un accusé REJOUÉ ne compte pas deux fois (Meta répète ses statuts)', async () => {
    expect(await store.recordStatusForMessage('wamid.itest.1', 'read')).toBe(0);
    const n = await pool.query(`select 1 from workflow_node_events where meta_message_id = $1 and kind = 'read'`, ['wamid.itest.1']);
    expect(n.rowCount).toBe(1);
  });

  it('délivré ET lu coexistent : ce sont deux mesures différentes', async () => {
    expect(await store.recordStatusForMessage('wamid.itest.1', 'delivered')).toBe(1);
    const n = await pool.query(`select kind from workflow_node_events where meta_message_id = $1`, ['wamid.itest.1']);
    expect(n.rowCount).toBe(3); // sent + read + delivered
  });

  it('🔴 un identifiant HORS scénario (inbox, campagne) ne crée rien', async () => {
    // Cette méthode voit TOUS les statuts du webhook. Inventer une ligne pour un message qu'aucun bloc n'a
    // envoyé polluerait les tableaux avec des mesures sans bloc.
    expect(await store.recordStatusForMessage('wamid.inconnu.999', 'read')).toBe(0);
  });

  it('supprimer le scénario emporte ses mesures (cascade)', async () => {
    const wf2 = (await pool.query<{ id: string }>(
      `insert into workflows (tenant_id, name) values ($1, 'itest-mesures-jetable') returning id`, [tenantId],
    )).rows[0]!.id;
    await store.record({ tenantId, workflowId: wf2, nodeId: 'x', waId: '33600009', kind: 'sent' });
    await pool.query('delete from workflows where id = $1', [wf2]);
    const reste = await pool.query('select 1 from workflow_node_events where workflow_id = $1', [wf2]);
    expect(reste.rowCount).toBe(0);
  });
});
