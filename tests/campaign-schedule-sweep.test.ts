import { describe, it, expect } from 'vitest';
import { runCampaignScheduleSweep } from '../src/campaign/schedule-sweep';
import type { ScheduleSweepDeps } from '../src/campaign/schedule-sweep';

/** Lot 8 Phase 5 : le sweeper enfile les campagnes programmées dues, avec le timeout de job dimensionné, et
 *  les passe en 'running'. Ordre enqueue -> markRunning ; un échec par campagne n'arrête pas le balayage. */
describe('runCampaignScheduleSweep', () => {
  it('enfile chaque campagne due (expire dimensionné) PUIS la passe en running', async () => {
    const enqueued: Array<{ id: string; expire: number }> = [];
    const ran: string[] = [];
    const deps: ScheduleSweepDeps = {
      listDue: async () => [
        { id: 'c1', ratePerMinute: 1, pendingCount: 1000 }, // 1000@1/min
        { id: 'c2', ratePerMinute: null, pendingCount: 5 },
      ],
      enqueueRun: async (id, expire) => { enqueued.push({ id, expire }); },
      markRunning: async (id) => { ran.push(id); return true; },
    };
    const n = await runCampaignScheduleSweep(deps);
    expect(n).toBe(2);
    // c1 : campaignJobExpireSeconds(1000,1) = 90600 brut, plafonné à 82800 (pg-boss refuse >= 24 h) ;
    // c2 : petite liste -> plancher 900.
    expect(enqueued).toEqual([{ id: 'c1', expire: 82_800 }, { id: 'c2', expire: 900 }]);
    expect(ran).toEqual(['c1', 'c2']);
  });

  it('aucune campagne due -> rien enfilé', async () => {
    let calls = 0;
    const n = await runCampaignScheduleSweep({
      listDue: async () => [],
      enqueueRun: async () => { calls += 1; },
      markRunning: async () => true,
    });
    expect(n).toBe(0);
    expect(calls).toBe(0);
  });

  it('un échec d enqueue sur une campagne n interrompt pas les suivantes', async () => {
    const ran: string[] = [];
    const n = await runCampaignScheduleSweep({
      listDue: async () => [
        { id: 'boom', ratePerMinute: null, pendingCount: 1 },
        { id: 'ok', ratePerMinute: null, pendingCount: 1 },
      ],
      enqueueRun: async (id) => { if (id === 'boom') throw new Error('file KO'); },
      markRunning: async (id) => { ran.push(id); return true; },
    });
    expect(n).toBe(1); // seule 'ok' comptée
    expect(ran).toEqual(['ok']); // 'boom' n'a pas été marquée running (enqueue a levé avant)
  });

  it('un échec par campagne est REMONTÉ : sans ça, la campagne se retente à vie sans une alerte', async () => {
    // Le balayage réussit (il continue), donc le catch du worker ne voit jamais cet échec. C'est ce mutisme
    // qui a laissé des campagnes bloquées en 'scheduled' pour toujours sans que personne ne le sache.
    const remontes: string[] = [];
    const n = await runCampaignScheduleSweep({
      listDue: async () => [{ id: 'boom', ratePerMinute: null, pendingCount: 1 }],
      enqueueRun: async () => { throw new Error('expiration cannot exceed 24 hours'); },
      markRunning: async () => true,
      onError: (msg, err) => remontes.push(`${msg} | ${err instanceof Error ? err.message : String(err)}`),
    });
    expect(n).toBe(0);
    expect(remontes).toHaveLength(1);
    // Le message doit nommer LA campagne (sinon l'alerte est inexploitable) et porter la cause.
    expect(remontes[0]).toContain('boom');
    expect(remontes[0]).toContain('expiration cannot exceed 24 hours');
  });
});
