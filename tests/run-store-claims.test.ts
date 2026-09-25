import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PgWorkflowRunStore } from '../src/workflow/run-store.pg';

/**
 * Les deux RÉCLAMATIONS du balayage de réveil (`claimDueSleeping`, `claimDueQuestions`) et les deux lectures
 * d'un run (`findWaitingByWaId`, `byId`) passent par une seule écriture (audit ponytail du 2026-09-25). Ce
 * test fige, sans base, la requête EXACTE que chacune envoie et la ligne qu'elle rend : le statut LITTÉRAL
 * (un paramètre à sa place priverait le planificateur des index partiels sur `status`), le bail de 15 minutes,
 * la borne de 90 jours, `skip locked`, et le statut rendu. Les tests d'intégration (stores, question-timeout)
 * restent ceux qui voient une base.
 */
function fauxPool(lignes: unknown[]) {
  const appels: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      appels.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return { rows: lignes, rowCount: lignes.length };
    },
  } as unknown as Pool;
  return { pool, appels };
}

const reclamation = (statut: string) =>
  `update workflow_runs r set resume_at = now() + interval '15 minutes', updated_at = now() from ( select id from workflow_runs where status = '${statut}' and resume_at is not null and resume_at <= now() and created_at > now() - interval '90 days' order by resume_at for update skip locked limit $1 ) due where r.id = due.id returning r.id, r.workflow_id, r.tenant_id, r.wa_id, r.contact_id, r.current_node, r.last_message_id, r.channel, r.graphe_fige`;

const ligne = {
  id: 'r1', workflow_id: 'w1', tenant_id: 't1', wa_id: '336', contact_id: 'c1', current_node: 'n2',
  last_message_id: 'wamid.1', channel: null, graphe_fige: null,
};

describe('PgWorkflowRunStore : les réclamations du balayage de réveil', () => {
  it.each([
    ['claimDueSleeping', 'sleeping'],
    ['claimDueQuestions', 'waiting'],
  ] as const)('%s réclame les runs `%s` dus, sous bail, et les rend avec ce statut', async (methode, statut) => {
    const { pool, appels } = fauxPool([ligne]);
    const rendus = await new PgWorkflowRunStore(pool)[methode](50);
    expect(appels).toEqual([{ sql: reclamation(statut), params: [50] }]);
    expect(rendus).toEqual([{
      id: 'r1', workflowId: 'w1', tenantId: 't1', waId: '336', contactId: 'c1', currentNode: 'n2',
      status: statut, lastMessageId: 'wamid.1', channel: 'whatsapp', grapheFige: null,
    }]);
  });
});

describe('PgWorkflowRunStore : la lecture d’un run', () => {
  const lu = { ...ligne, status: 'waiting', channel: 'rcs' };
  const attendu = {
    id: 'r1', workflowId: 'w1', tenantId: 't1', waId: '336', currentNode: 'n2', status: 'waiting',
    lastMessageId: 'wamid.1', channel: 'rcs', grapheFige: null,
  };

  it('findWaitingByWaId : le plus récent en attente de CE contact', async () => {
    const { pool, appels } = fauxPool([lu]);
    expect(await new PgWorkflowRunStore(pool).findWaitingByWaId('t1', '336')).toEqual(attendu);
    expect(appels[0]!.params).toEqual(['t1', '336']);
    expect(appels[0]!.sql).toBe("select id, workflow_id, tenant_id, wa_id, current_node, status, last_message_id, channel, graphe_fige from workflow_runs where tenant_id = $1 and wa_id = $2 and status = 'waiting' order by created_at desc limit 1");
  });

  it('byId : quel que soit son statut, et `null` quand il n’existe pas', async () => {
    const { pool, appels } = fauxPool([lu]);
    expect(await new PgWorkflowRunStore(pool).byId('t1', 'r1')).toEqual(attendu);
    expect(appels[0]!.sql).toBe('select id, workflow_id, tenant_id, wa_id, current_node, status, last_message_id, channel, graphe_fige from workflow_runs where tenant_id = $1 and id = $2');
    expect(await new PgWorkflowRunStore(fauxPool([]).pool).byId('t1', 'r1')).toBeNull();
  });
});
