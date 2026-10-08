import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { offreEnMemoire, oublierOffre } from './use-offre';

/**
 * LA MÉMOIRE DE L'OFFRE (lot 6) : lue une fois par minute au plus, jamais gardée sur une panne, et une API sans la route
 * (404) rend `null`, c'est-à-dire tout ouvert.
 */
const VUE = {
  offre: 'entreprise', fonctions: [], usage: { envoisModelesMois: null, contacts: 0, automations: 0, membres: 1 }, upgradeUrl: 'u',
  limites: { utilisateurs: null, admins: null, contacts: null, envoisModelesMois: null, automations: null, suppressionsJour: null,
    adressesWebhook: 5, journalWebhooksJours: 30, conservationJours: 90, commissionPct: 10, badge: false, numeroInclus: true },
};
const vue = { ...VUE, grille: { free: VUE, pro: VUE, entreprise: VUE } };

describe('offreEnMemoire', () => {
  beforeEach(() => { oublierOffre(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const repondre = (status: number, corps: unknown) => {
    const f = vi.fn(async () => new Response(JSON.stringify(corps), { status, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', f);
    return f;
  };

  it('lit une fois, puis sert la mémoire pendant une minute, et relit après', async () => {
    const f = repondre(200, vue);
    expect((await offreEnMemoire('t1', 0))?.offre).toBe('entreprise');
    await offreEnMemoire('t1', 59_000);
    expect(f).toHaveBeenCalledTimes(1);
    await offreEnMemoire('t1', 61_000);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('un autre espace relit', async () => {
    const f = repondre(200, vue);
    await offreEnMemoire('t1', 0);
    await offreEnMemoire('t2', 1);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('🔴 une API sans la route (404) rend null : tout ouvert', async () => {
    repondre(404, { error: 'Not Found' });
    expect(await offreEnMemoire('t1', 0)).toBeNull();
  });

  it('🔴 une panne rend null et n’est PAS gardée : la page suivante relit', async () => {
    const f = repondre(503, { error: 'indisponible' });
    expect(await offreEnMemoire('t1', 0)).toBeNull();
    // Un GET en 5xx est déjà rejoué une fois par le client HTTP : on compte ce qui vient APRÈS.
    const avant = f.mock.calls.length;
    await offreEnMemoire('t1', 1);
    expect(f.mock.calls.length).toBeGreaterThan(avant);
  });
});
