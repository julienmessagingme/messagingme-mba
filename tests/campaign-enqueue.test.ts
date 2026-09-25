import { describe, it, expect } from 'vitest';
import { enqueueCampaignRun, relanceurDeCampagnes } from '../src/campaign/enqueue';
import type { Queue } from '../src/queue/queue';

/** File espionne : retient le nom, la charge et les options de chaque enfilement. */
function fileEspionne() {
  const envois: Array<{ name: string; data: unknown; opts?: { expireInSeconds?: number; groupId?: string } }> = [];
  const queue = {
    enqueue: async (name: string, data: unknown, opts?: { expireInSeconds?: number; groupId?: string }) => {
      envois.push({ name, data, ...(opts ? { opts } : {}) });
    },
    work: async () => {},
  } as unknown as Queue;
  return { queue, envois };
}

/**
 * ENFILEMENT D'UN RUN DE CAMPAGNE (lot 5 du programme, 2026-08-31).
 *
 * 🔴 Le `groupId` est ce qui rend la concurrence ÉQUITABLE. Le worker plafonne la file à un run par groupe,
 * le groupe étant l'espace : sans lui, un client qui lance quatre campagnes occuperait les quatre places de
 * la file et affamerait tous les autres. C'est exactement le problème que la concurrence est censée résoudre,
 * donc l'oublier serait le rendre pire qu'avant.
 */
describe('enqueueCampaignRun', () => {
  it('🔴 le groupe de la file est l’ESPACE, pas la campagne', async () => {
    const { queue, envois } = fileEspionne();
    await enqueueCampaignRun(queue, { campaignId: 'c1', tenantId: 't-42', pendingCount: 100, resolvedRatePerMinute: 30 });
    expect(envois).toHaveLength(1);
    expect(envois[0]!.name).toBe('campaign-run');
    expect(envois[0]!.data).toEqual({ campaignId: 'c1' });
    expect(envois[0]!.opts?.groupId).toBe('t-42');
  });

  it('l’expiration est dimensionnée sur le travail réel (elle ne retombe jamais sur le défaut de la file)', async () => {
    const { queue, envois } = fileEspionne();
    // 5 000 destinataires à 30/min = 2 h 47 de travail : l'expiration doit couvrir ça, très au-delà du défaut
    // de 15 minutes de la file, sinon le job expire en plein envoi et pg-boss le rejoue en parallèle.
    await enqueueCampaignRun(queue, { campaignId: 'c1', tenantId: 't-42', pendingCount: 5000, resolvedRatePerMinute: 30 });
    expect(envois[0]!.opts?.expireInSeconds).toBeGreaterThan(2 * 60 * 60);
  });

  it('deux espaces -> deux groupes distincts (ils ne se bloquent pas l’un l’autre)', async () => {
    const { queue, envois } = fileEspionne();
    await enqueueCampaignRun(queue, { campaignId: 'c1', tenantId: 't-a', pendingCount: 1, resolvedRatePerMinute: 30 });
    await enqueueCampaignRun(queue, { campaignId: 'c2', tenantId: 't-b', pendingCount: 1, resolvedRatePerMinute: 30 });
    expect(envois.map((e) => e.opts?.groupId)).toEqual(['t-a', 't-b']);
  });
});

/**
 * LE RELANCEUR D'UN PROCESS (audit ponytail du 2026-09-25) : les cinq relances du worker et l'envoi de l'API
 * publique résolvaient chacun le débit à la main. Il doit rendre EXACTEMENT l'enfilement que chacun faisait :
 * débit stocké, sinon défaut du serveur, borné par le plafond du canal le plus bas.
 */
describe('relanceurDeCampagnes', () => {
  const config = { CAMPAIGN_DEFAULT_RATE_PER_MINUTE: 30, PHONE_RATE_PER_MINUTE_MAX: 80, RCS_RATE_PER_MINUTE_MAX: 60 };
  const attendu = async (pendingCount: number, resolvedRatePerMinute: number) => {
    const { queue, envois } = fileEspionne();
    await enqueueCampaignRun(queue, { campaignId: 'c1', tenantId: 't-42', pendingCount, resolvedRatePerMinute });
    return envois;
  };

  it.each([
    ['débit stocké, sous le plafond', 20, 20],
    ['débit absent -> défaut du serveur', null, 30],
    ['débit au-dessus du plafond le plus BAS (RCS, 60) -> borné', 500, 60],
  ] as const)('%s', async (_cas, stocke, resolu) => {
    const { queue, envois } = fileEspionne();
    await relanceurDeCampagnes(queue, config)({ campaignId: 'c1', tenantId: 't-42', pendingCount: 5000, ratePerMinute: stocke });
    expect(envois).toEqual(await attendu(5000, resolu));
  });
});
