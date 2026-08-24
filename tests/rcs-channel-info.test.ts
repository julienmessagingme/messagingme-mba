import { describe, it, expect } from 'vitest';
import { verifierCleRcs } from '../src/rcs/channel-info';
import type { HttpGet } from '../src/rcs/channel-info';

function transport(reponse: { status: number; json: unknown } | Error): HttpGet {
  return {
    async get() {
      if (reponse instanceof Error) throw reponse;
      return reponse;
    },
  };
}

/** Réponse réelle observée pour le canal RCS de MessagingMe (2026-08-24). */
const CANAL_RCS = {
  items: [{
    channelId: '3bbcd3a1-67f5-4f96-be82-949b26f4fdae',
    name: 'CANAL RCS (test)',
    type: 'RCS',
    flow: 'MARKETING',
    defaultFromField: 'MessagingMe',
    dailyConsumptionLimit: 500,
    dailyConsumption: 0,
    monthlyConsumptionLimit: 300,
    monthlyConsumption: 12,
  }],
};

/** Réponse réelle observée pour la PREMIÈRE clé, rattachée au canal SMS. */
const CANAL_SMS = {
  items: [{ channelId: 'e06319df', name: 'CANAL SMS (non utilisé)', type: 'SMS', flow: 'MARKETING', defaultFromField: '36034' }],
};

describe('verifierCleRcs', () => {
  it('rend l agent, le flux et les quotas d un canal RCS', async () => {
    const r = await verifierCleRcs(transport({ status: 200, json: CANAL_RCS }), 'cle');
    expect(r).toEqual({
      ok: true,
      channel: {
        channelId: '3bbcd3a1-67f5-4f96-be82-949b26f4fdae',
        name: 'CANAL RCS (test)',
        agentName: 'MessagingMe',
        flow: 'MARKETING',
        dailyLimit: 500,
        dailyUsed: 0,
        monthlyLimit: 300,
        monthlyUsed: 12,
      },
    });
  });

  it('REFUSE une cle de canal SMS, en disant pourquoi', async () => {
    const r = await verifierCleRcs(transport({ status: 200, json: CANAL_SMS }), 'cle-sms');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no_rcs_channel');
    // Le message doit nommer ce qu'on a vu, sinon l'operateur ne sait pas quoi demander a son fournisseur.
    expect(r.detail).toContain('SMS');
  });

  it('REFUSE une cle invalide', async () => {
    for (const status of [401, 403]) {
      const r = await verifierCleRcs(transport({ status, json: {} }), 'mauvaise');
      expect(r).toMatchObject({ ok: false, reason: 'invalid_key' });
    }
  });

  it('signale une panne reseau sans la confondre avec une cle invalide', async () => {
    const r = await verifierCleRcs(transport(new Error('ECONNRESET')), 'cle');
    expect(r).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('signale une reponse vide comme absence de canal RCS, pas comme un succes', async () => {
    const r = await verifierCleRcs(transport({ status: 200, json: { items: [] } }), 'cle');
    expect(r).toMatchObject({ ok: false, reason: 'no_rcs_channel' });
  });
});
