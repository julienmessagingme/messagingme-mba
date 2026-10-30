import { describe, it, expect } from 'vitest';
import { runCampaignScheduleSweep } from '../src/campaign/schedule-sweep';
import type { ScheduleSweepDeps } from '../src/campaign/schedule-sweep';

/** Aucun espace sur la ligne du Crédit WhatsApp : le départ ne regarde pas le crédit, et le test le DIT. */
const horsLigne: ScheduleSweepDeps['creditAuDepart'] = { estimer: async () => null, pauser: async () => true };

/** Lot 8 Phase 5 : le sweeper enfile les campagnes programmées dues, avec le timeout de job dimensionné, et
 *  les passe en 'running'. Ordre enqueue -> markRunning ; un échec par campagne n'arrête pas le balayage. */
describe('runCampaignScheduleSweep', () => {
  it('enfile chaque campagne due (expire dimensionné) PUIS la passe en running', async () => {
    const enqueued: Array<{ id: string; tenantId: string; expire: number }> = [];
    const ran: string[] = [];
    const deps: ScheduleSweepDeps = {
      repo: {
        listDueScheduled: async () => [
          { id: 'c1', tenantId: 't-c1', ratePerMinute: 1, pendingCount: 1000 }, // 1000@1/min
          { id: 'c2', tenantId: 't-c2', ratePerMinute: null, pendingCount: 5 },
        ],
        markScheduledRunning: async (id) => { ran.push(id); return true; },
      },
      enqueueRun: async (id, tenantId, expire) => { enqueued.push({ id, tenantId, expire }); },
      creditAuDepart: horsLigne,
    };
    const n = await runCampaignScheduleSweep(deps);
    expect(n).toBe(2);
    // c1 : campaignJobExpireSeconds(1000,1) = 90600 brut, plafonné à 82800 (pg-boss refuse >= 24 h) ;
    // c2 : petite liste -> plancher 900.
    // 🔴 Le GROUPE de la file est l'espace : sans lui, une campagne programmée échapperait au plafond de
    // concurrence par espace (lot 5).
    expect(enqueued).toEqual([{ id: 'c1', tenantId: 't-c1', expire: 82_800 }, { id: 'c2', tenantId: 't-c2', expire: 900 }]);
    expect(ran).toEqual(['c1', 'c2']);
  });

  it('aucune campagne due -> rien enfilé', async () => {
    let calls = 0;
    const n = await runCampaignScheduleSweep({
      repo: {
        listDueScheduled: async () => [],
        markScheduledRunning: async () => true,
      },
      enqueueRun: async () => { calls += 1; },
      creditAuDepart: horsLigne,
    });
    expect(n).toBe(0);
    expect(calls).toBe(0);
  });

  it('un échec d enqueue sur une campagne n interrompt pas les suivantes', async () => {
    const ran: string[] = [];
    const n = await runCampaignScheduleSweep({
      repo: {
        listDueScheduled: async () => [
          { id: 'boom', tenantId: 't-boom', ratePerMinute: null, pendingCount: 1 },
          { id: 'ok', tenantId: 't-ok', ratePerMinute: null, pendingCount: 1 },
        ],
        markScheduledRunning: async (id) => { ran.push(id); return true; },
      },
      enqueueRun: async (id) => { if (id === 'boom') throw new Error('file KO'); },
      creditAuDepart: horsLigne,
    });
    expect(n).toBe(1); // seule 'ok' comptée
    expect(ran).toEqual(['ok']); // 'boom' n'a pas été marquée running (enqueue a levé avant)
  });

  it('un échec par campagne est REMONTÉ : sans ça, la campagne se retente à vie sans une alerte', async () => {
    // Le balayage réussit (il continue), donc le catch du worker ne voit jamais cet échec. C'est ce mutisme
    // qui a laissé des campagnes bloquées en 'scheduled' pour toujours sans que personne ne le sache.
    const remontes: string[] = [];
    const n = await runCampaignScheduleSweep({
      repo: {
        listDueScheduled: async () => [{ id: 'boom', tenantId: 't-boom', ratePerMinute: null, pendingCount: 1 }],
        markScheduledRunning: async () => true,
      },
      enqueueRun: async () => { throw new Error('expiration cannot exceed 24 hours'); },
      creditAuDepart: horsLigne,
      onError: (msg, err) => remontes.push(`${msg} | ${err instanceof Error ? err.message : String(err)}`),
    });
    expect(n).toBe(0);
    expect(remontes).toHaveLength(1);
    // Le message doit nommer LA campagne (sinon l'alerte est inexploitable) et porter la cause.
    expect(remontes[0]).toContain('boom');
    expect(remontes[0]).toContain('expiration cannot exceed 24 hours');
  });

  it('🔴 il manque du Crédit WhatsApp au départ : la campagne passe en pause, rien n’est enfilé ni marqué en cours', async () => {
    const enfilees: string[] = [];
    const ran: string[] = [];
    const pauses: string[] = [];
    const n = await runCampaignScheduleSweep({
      repo: {
        listDueScheduled: async () => [
          { id: 'courte', tenantId: 't1', ratePerMinute: null, pendingCount: 1 },
          { id: 'couverte', tenantId: 't1', ratePerMinute: null, pendingCount: 1 },
        ],
        markScheduledRunning: async (id) => { ran.push(id); return true; },
      },
      enqueueRun: async (id) => { enfilees.push(id); },
      creditAuDepart: {
        estimer: async (_t, id) => (id === 'courte'
          ? { montantMicroEur: 2_480_000, soldeMicroEur: 0, manqueMicroEur: 2_480_000 }
          : { montantMicroEur: 2_480_000, soldeMicroEur: 9_000_000, manqueMicroEur: 0 }),
        pauser: async (id, t, montant) => { pauses.push(`${id}:${t}:${montant}`); return true; },
      },
    });
    expect(pauses).toEqual(['courte:t1:2480000']);
    expect(enfilees).toEqual(['couverte']);
    expect(ran).toEqual(['couverte']);
    expect(n).toBe(1);
  });

  it('une pause non écrite (un crédit arrivé entre-temps) laisse la campagne due, sans l’enfiler à ce tour', async () => {
    const enfilees: string[] = [];
    await runCampaignScheduleSweep({
      repo: {
        listDueScheduled: async () => [{ id: 'c', tenantId: 't1', ratePerMinute: null, pendingCount: 1 }],
        markScheduledRunning: async () => true,
      },
      enqueueRun: async (id) => { enfilees.push(id); },
      creditAuDepart: { estimer: async () => ({ montantMicroEur: 10, soldeMicroEur: 0, manqueMicroEur: 10 }), pauser: async () => false },
    });
    expect(enfilees).toEqual([]);
  });
});

