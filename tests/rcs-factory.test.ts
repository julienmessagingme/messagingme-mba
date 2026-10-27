import { describe, it, expect } from 'vitest';
import { buildRcsStack } from '../src/rcs/factory';
import { PgRcsAgentStore } from '../src/rcs/store.pg';
import { OFFRES_RCS } from '../src/offres/offres';
import type { Pool } from 'pg';
import type { Campaign } from '../src/campaign/types';

/** La fabrique ne touche la base qu'à l'usage : un pool factice suffit pour juger le CHOIX du provider. */
const pool = {} as Pool;

const campagne: Campaign = {
  id: 'c1', tenantId: 't1', phoneNumberId: '', category: 'marketing',
  templateName: '', templateLanguage: '', paramMapping: [], status: 'draft',
  workflowId: null, startNodeId: null, ratePerMinute: null,
  channel: 'rcs', rcsAgentId: 'agent-1', rcsMessage: { kind: 'text', text: 'Bonjour' },
};

describe('buildRcsStack', () => {
  it('LEVE si smsmode est demande SANS la cle du canal RCS', () => {
    expect(() => buildRcsStack(pool, 'smsmode', false)).toThrow(/SMSMODE_RCS_API_KEY/);
    expect(() => buildRcsStack(pool, 'smsmode', false, { apiKey: '' })).toThrow(/SMSMODE_RCS_API_KEY/);
  });

  it('monte la pile smsmode avec sa cle', () => {
    const stack = buildRcsStack(pool, 'smsmode', false, { apiKey: 'cle-canal-rcs' });
    expect(stack.sender).toBeDefined();
  });

  it('DRY_RUN prime aussi sur smsmode : aucune cle exigee, aucun envoi reel', () => {
    expect(() => buildRcsStack(pool, 'smsmode', true)).not.toThrow();
  });

  it('monte la pile sur le provider factice', () => {
    const stack = buildRcsStack(pool, 'fake', false);
    expect(stack.sender).toBeDefined();
    expect(stack.agents).toBeDefined();
  });

  it('senderForCampaign rend null quand la campagne n a pas d agent', async () => {
    const stack = buildRcsStack(pool, 'fake', false);
    expect(await stack.senderForCampaign({ ...campagne, rcsAgentId: null })).toBeNull();
  });

  it('senderForCampaign rend null quand la campagne n a pas de message', async () => {
    const stack = buildRcsStack(pool, 'fake', false);
    expect(await stack.senderForCampaign({ ...campagne, rcsMessage: undefined })).toBeNull();
  });

  it('senderForCampaign rend un sender exploitable pour une campagne complete', async () => {
    const stack = buildRcsStack(offre(true).pool, 'fake', false);
    const sender = await stack.senderForCampaign(campagne);
    expect(sender).not.toBeNull();
  });

  it('🔴 une campagne RCS d’un espace dont l’offre n’ouvre plus le RCS (descendu de l’Entreprise) : aucun expéditeur (spec Business)', async () => {
    // L'agent est figé sur la campagne : sans cette relecture, un espace descendu au Business enverrait encore du RCS.
    const ferme = offre(false);
    expect(await buildRcsStack(ferme.pool, 'fake', false).senderForCampaign(campagne)).toBeNull();
    expect(ferme.requetes[0]!.params).toEqual(['t1', ['entreprise']]);
  });
});

/** Un pool qui répond à la seule question de l'offre : le RCS est-il ouvert à l'espace ? */
function offre(ouvert: boolean) {
  const requetes: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      requetes.push({ sql, params: params ?? [] });
      return { rows: [{ ouvert, agent_id: ouvert ? 'agent-1' : null }], rowCount: 1 };
    },
  } as unknown as Pool;
  return { pool, requetes };
}

describe('l’agent RCS d’un espace', () => {
  it('🔴 ne se résout que si l’offre de l’espace ouvre le RCS, lue dans la grille, en SQL (spec Business)', async () => {
    const { pool: p, requetes } = offre(true);
    expect(await new PgRcsAgentStore(p).agentIdForTenant('t1')).toBe('agent-1');
    expect(requetes[0]!.sql).toMatch(/offre_de_l_espace\(\$1::uuid\) = any\(\$2::text\[\]\)/);
    expect(requetes[0]!.params).toEqual(['t1', [...OFFRES_RCS]]);
    expect([...OFFRES_RCS]).toEqual(['entreprise']);
  });
});

