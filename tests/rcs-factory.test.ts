import { describe, it, expect } from 'vitest';
import { buildRcsStack } from '../src/rcs/factory';
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
  it('LEVE au demarrage sur un provider non implemente, au lieu de retomber en silence sur le factice', () => {
    expect(() => buildRcsStack(pool, 'google', false)).toThrow(/google/);
  });

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

  it('DRY_RUN force le provider factice, meme quand google est demande', () => {
    // Sans cette règle, un déploiement DRY_RUN=true enverrait du vrai RCS le jour où google existera.
    expect(() => buildRcsStack(pool, 'google', true)).not.toThrow();
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
    const stack = buildRcsStack(pool, 'fake', false);
    const sender = await stack.senderForCampaign(campagne);
    expect(sender).not.toBeNull();
  });
});
