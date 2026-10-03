import { describe, it, expect } from 'vitest';
import type { LatenceHttpRow } from './api';
import { AUTRES_MAX, EFFECTIF_MIN, SEUIL_P95_MS, doitEtreRapide, enAlerte, ordonnerLatences } from './latence-http';

const ligne = (p: Partial<LatenceHttpRow>): LatenceHttpRow => ({
  methode: 'GET', route: '/x', code: 200, groupe: 'autres', requetes: 100, p50Ms: 10, p95Ms: 25, maxMs: 30, moyenneMs: 9, ...p,
});

describe('ce qui passe en rouge sur la carte de latence HTTP', () => {
  it('un webhook ou une lecture de l’Inbox au-delà du seuil, avec l’effectif', () => {
    expect(enAlerte(ligne({ groupe: 'webhooks', methode: 'POST', route: '/webhooks/meta', p95Ms: 1200 }))).toBe(true);
    expect(enAlerte(ligne({ groupe: 'inbox', route: '/tenants/:tenantId/conversations', p95Ms: 1200 }))).toBe(true);
  });

  it('le seuil est strict : un p95 « ≤ 800 ms » reste neutre', () => {
    expect(enAlerte(ligne({ groupe: 'inbox', route: '/tenants/:tenantId/conversations', p95Ms: SEUIL_P95_MS }))).toBe(false);
  });

  it('pas sur un effectif trop faible pour qu’un p95 compte', () => {
    expect(enAlerte(ligne({ groupe: 'webhooks', p95Ms: 5000, requetes: EFFECTIF_MIN - 1 }))).toBe(false);
    expect(enAlerte(ligne({ groupe: 'webhooks', p95Ms: 5000, requetes: EFFECTIF_MIN }))).toBe(true);
  });

  it('pas sur ce qui est lent par nature : écritures et médias de l’Inbox, API publique, autres routes', () => {
    const lent = { p95Ms: 5000 };
    expect(enAlerte(ligne({ ...lent, groupe: 'inbox', methode: 'POST', route: '/tenants/:tenantId/conversations/:conversationId/traduire' }))).toBe(false);
    expect(enAlerte(ligne({ ...lent, groupe: 'inbox', route: '/tenants/:tenantId/conversations/:conversationId/messages/:messageId/media' }))).toBe(false);
    expect(enAlerte(ligne({ ...lent, groupe: 'v1', methode: 'POST', route: '/v1/sends' }))).toBe(false);
    expect(enAlerte(ligne({ ...lent, groupe: 'autres', route: '/tenants/:tenantId/contacts/import' }))).toBe(false);
    expect(doitEtreRapide(ligne({ groupe: 'inbox', route: '/tenants/:tenantId/conversations/:conversationId/messages' }))).toBe(true);
  });
});

describe('l’ordre de la carte', () => {
  it('les groupes dans l’ordre de l’audit, les vides retirés', () => {
    const g = ordonnerLatences([
      ligne({ groupe: 'autres' }), ligne({ groupe: 'webhooks', route: '/webhooks/meta' }), ligne({ groupe: 'v1', route: '/v1/sends' }),
    ]);
    expect(g.map((x) => x.cle)).toEqual(['webhooks', 'v1', 'autres']);
  });

  it('dans un groupe : d’abord ce qui a l’effectif, la plus lente en tête', () => {
    const [g] = ordonnerLatences([
      ligne({ groupe: 'inbox', route: '/a', p95Ms: 100, requetes: 500 }),
      ligne({ groupe: 'inbox', route: '/b', p95Ms: 9000, requetes: 2 }),
      ligne({ groupe: 'inbox', route: '/c', p95Ms: 500, requetes: 50 }),
    ]);
    expect(g!.lignes.map((l) => l.route)).toEqual(['/c', '/a', '/b']);
  });

  it('les autres routes au-delà du maximum : cachées, et comptées', () => {
    const autres = Array.from({ length: AUTRES_MAX + 4 }, (_, i) => ligne({ route: `/r${i}`, p95Ms: i }));
    const [g] = ordonnerLatences(autres);
    expect(g!.lignes).toHaveLength(AUTRES_MAX);
    expect(g!.cachees).toBe(4);
    expect(g!.lignes[0]!.route).toBe(`/r${AUTRES_MAX + 3}`);
  });

  it('les groupes prioritaires ne sont jamais tronqués', () => {
    const inbox = Array.from({ length: AUTRES_MAX + 4 }, (_, i) => ligne({ groupe: 'inbox', route: `/i${i}` }));
    const [g] = ordonnerLatences(inbox);
    expect(g!.lignes).toHaveLength(AUTRES_MAX + 4);
    expect(g!.cachees).toBe(0);
  });

  it('le total, les 5xx et les abandons du groupe', () => {
    const [g] = ordonnerLatences([
      ligne({ groupe: 'webhooks', requetes: 100 }),
      ligne({ groupe: 'webhooks', code: 500, requetes: 3 }),
      ligne({ groupe: 'webhooks', code: 499, requetes: 2 }),
    ]);
    expect(g).toMatchObject({ requetes: 105, erreurs: 3, abandons: 2 });
  });
});
