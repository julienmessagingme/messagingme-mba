import { describe, it, expect } from 'vitest';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import type { OpsRouteDeps } from '../src/http/ops';
import type { BilanRisque } from '../src/engagement/balayage';

/**
 * LE BALAYAGE DU RISQUE À LA DEMANDE (`POST /ops/risque/:tenantId`, lot 7 de l'API publique).
 *
 * C'est une ÉCRITURE d'exploitation (il écrit le risque et peut déclencher des automations) : même autorité
 * séparée que les autres (le jeton d'exploitation, jamais un JWT client), même note obligatoire.
 */
const OPS = 'ops-secret-token-of-at-least-32-bytes!!';
const T = '0b8f5c1e-3d2a-4c6b-9e7f-1a2b3c4d5e6f';
const avecJeton = (t: string) => ({ headers: { 'content-type': 'application/json', 'x-ops-token': t } });
const BILAN: BilanRisque = {
  tenantId: T, evalues: 12, transitions: 3, declenches: 1, dejaDeclenches: 0, departLe: '2026-09-25T07:00:00.000Z',
  auDelaDuPlafond: 0, sansDeclencheur: 2, echecsPublication: 0,
};

function app(over: Partial<OpsRouteDeps> = {}) {
  const deps: OpsRouteDeps = { getTenantOverview: async () => [], getGlobalDaily: async () => [], getQueueLoad: async () => [], ...over };
  return buildServer({ queue: new FakeQueue(), ops: deps, opsToken: OPS });
}

describe('POST /ops/risque/:tenantId', () => {
  it('lance le balayage de l’espace et rend son bilan', async () => {
    const lances: string[] = [];
    const a = app({ balayerRisque: async (t) => { lances.push(t); return BILAN; } });
    const res = await a.inject({ method: 'POST', url: `/ops/risque/${T}`, payload: { note: 'essai réel du lot 7' }, ...avecJeton(OPS) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ bilan: BILAN });
    expect(lances).toEqual([T]);
    await a.close();
  });

  it('🔴 sans le jeton d’exploitation : refus, et rien n’est lancé', async () => {
    let lance = false;
    const a = app({ balayerRisque: async () => { lance = true; return BILAN; } });
    const res = await a.inject({ method: 'POST', url: `/ops/risque/${T}`, payload: { note: 'essai réel du lot 7' }, ...avecJeton('mauvais') });
    expect(res.statusCode).toBe(401);
    expect(lance).toBe(false);
    await a.close();
  });

  it('la note est exigée : c’est la seule trace de qui a lancé le balayage', async () => {
    let lance = false;
    const a = app({ balayerRisque: async () => { lance = true; return BILAN; } });
    const res = await a.inject({ method: 'POST', url: `/ops/risque/${T}`, payload: { note: ' ' }, ...avecJeton(OPS) });
    expect(res.statusCode).toBe(400);
    expect(lance).toBe(false);
    await a.close();
  });

  it('un espace inconnu ou un identifiant mal formé : 404, jamais un 500', async () => {
    const a = app({ balayerRisque: async () => null });
    expect((await a.inject({ method: 'POST', url: `/ops/risque/${T}`, payload: { note: 'essai' }, ...avecJeton(OPS) })).statusCode).toBe(404);
    expect((await a.inject({ method: 'POST', url: '/ops/risque/pas-un-uuid', payload: { note: 'essai' }, ...avecJeton(OPS) })).statusCode).toBe(404);
    await a.close();
  });

  it('câblage absent : 503, plutôt que de laisser croire au geste', async () => {
    const a = app();
    expect((await a.inject({ method: 'POST', url: `/ops/risque/${T}`, payload: { note: 'essai' }, ...avecJeton(OPS) })).statusCode).toBe(503);
    await a.close();
  });
});
