import { describe, it, expect, beforeAll } from 'vitest';
import { creerLecteurFacture, synthetiser, API_FACTURATION } from '../src/ops/facture-scaleway';
import type { HttpGet } from '../src/lib/http-get';
import { buildServer } from '../src/server';
import { FakeQueue } from './fake-queue';
import type { OpsRouteDeps } from '../src/http/ops';
import { exploitationInerte, opsInerte } from './routes-inertes';
import { accesOps } from './acces-ops';

/**
 * LE COÛT SCALEWAY DU MOIS DANS /OPS (refonte, lot 3). Les réponses du faux GET ont la forme mesurée le 2026-10-29 par
 * la CLI (`billing consumption list`) : `{ consumptions, total_count, total_discount_untaxed_value, updated_at }`.
 */

const ligne = (categorie: string, produit: string, units: number, nanos = 0, devise = 'EUR') => ({
  value: { currency_code: devise, units, nanos }, product_name: produit, resource_name: 'r', sku: '/x', category_name: categorie,
  unit: 'hour', billed_quantity: '1',
});
const reponse = (consumptions: unknown[], total = consumptions.length, remise = 100) => ({
  status: 200, json: { consumptions, total_count: total, total_discount_untaxed_value: remise, updated_at: '2026-10-29T08:04:24.569843Z' },
});
/** Le 29 octobre à 08 h UTC : 28 jours et un tiers écoulés sur 31. */
const LE_29 = new Date('2026-10-29T08:00:00.000Z');

describe('synthetiser : le coût du mois, sa projection, ses postes', () => {
  it('🔴 au rythme du mois : le total rapporté aux jours écoulés, étendu au mois entier ; par poste, du plus cher au moins cher', () => {
    const c = synthetiser([
      ligne('Managed Databases', 'DB-DEV-M', 55, 520_000_000), ligne('Compute', 'DEV1-M', 18, 480_000_000),
      ligne('Managed Databases', 'Volume', 0, 0), ligne('Serverless', 'Containers', 17, 170_000_000),
    ], 100, '2026-10-29T08:04:24Z', LE_29);
    expect(c.totalHt).toBe(91.17);
    expect(c.periode).toBe('2026-10');
    expect(c.joursDuMois).toBe(31);
    expect(c.joursEcoules).toBe(28.3);
    expect(c.projectionHt).toBe(Math.round((91.17 / (28 + 8 / 24)) * 31 * 100) / 100);
    expect(c.postes).toEqual([
      { categorie: 'Managed Databases', montantHt: 55.52 }, { categorie: 'Compute', montantHt: 18.48 }, { categorie: 'Serverless', montantHt: 17.17 },
    ]);
    // Les lignes à zéro ne s'affichent pas ; la remise annoncée est rendue telle quelle.
    expect(c.lignes.map((l) => l.produit)).toEqual(['DB-DEV-M', 'DEV1-M', 'Containers']);
    expect(c.remiseHt).toBe(100);
  });

  it('🔴 un avoir (négatif, units et nanos de même signe) baisse le total ET reste dans les postes, qui s’additionnent au total', () => {
    const c = synthetiser([ligne('Compute', 'DEV1-M', 18, 500_000_000), ligne('Avoirs', 'Bon', -5, -500_000_000)], 0, null, LE_29);
    expect(c.totalHt).toBe(13);
    expect(c.postes).toEqual([{ categorie: 'Compute', montantHt: 18.5 }, { categorie: 'Avoirs', montantHt: -5.5 }]);
    expect(c.postes.reduce((t, p) => t + p.montantHt, 0)).toBe(c.totalHt);
  });

  it('🔴 la projection se rapporte aux jours que couvrent les données (la mise à jour de Scaleway), pas à l’heure murale', () => {
    const maintenant = new Date('2026-10-02T12:00:00.000Z');
    const c = synthetiser([ligne('Compute', 'a', 10)], 0, '2026-10-02T00:00:00.000Z', maintenant);
    expect(c.joursEcoules).toBe(1);
    expect(c.projectionHt).toBe(310);
    // Une mise à jour illisible ou dans le futur : l'heure murale.
    expect(synthetiser([ligne('Compute', 'a', 10)], 0, '2026-10-03T00:00:00.000Z', maintenant).joursEcoules).toBe(1.5);
  });

  it('le premier jour, trop tôt pour projeter : pas de projection', () => {
    expect(synthetiser([ligne('Compute', 'x', 1)], 0, null, new Date('2026-11-01T05:00:00.000Z')).projectionHt).toBeNull();
  });
});

describe('le lecteur de la facturation', () => {
  function faux(repondre: (page: number) => { status: number; json: unknown } | 'jette') {
    const appels: Array<{ url: string; headers: Record<string, string>; signal?: AbortSignal }> = [];
    const http: HttpGet = {
      async get(url, headers, opts) {
        appels.push({ url, headers, ...(opts?.signal ? { signal: opts.signal } : {}) });
        const r = repondre(Number(new URL(url).searchParams.get('page')));
        if (r === 'jette') throw new Error('réseau');
        return r;
      },
    };
    return { http, appels };
  }

  it('🔴 la clé en X-Auth-Token, l’organisation et le mois demandés, les pages jusqu’à une page incomplète', async () => {
    const pleine = Array.from({ length: 100 }, () => ligne('Compute', 'a', 1));
    const { http, appels } = faux((n) => (n === 1 ? reponse(pleine, 38) : reponse([ligne('Network', 'b', 3)], 38)));
    const c = await creerLecteurFacture({ cle: 'cle-test', organisationId: 'org-1', http, maintenant: () => LE_29 }).lire();
    // `total_count` (38 ici) ne décide pas de la fin : seule une page incomplète la dit.
    expect(c?.totalHt).toBe(103);
    expect(appels).toHaveLength(2);
    expect(appels[0]!.url).toBe(`${API_FACTURATION}?organization_id=org-1&billing_period=2026-10&order_by=category_name_asc&page_size=100&page=1`);
    expect(appels[0]!.headers).toEqual({ 'x-auth-token': 'cle-test' });
    expect(appels.every((a) => a.signal instanceof AbortSignal)).toBe(true);
  });

  it('🔴 au-delà de dix pages pleines : rien plutôt qu’un total tronqué affiché comme vrai', async () => {
    const signales: unknown[] = [];
    const { http, appels } = faux(() => reponse(Array.from({ length: 100 }, () => ligne('Compute', 'a', 1))));
    expect(await creerLecteurFacture({ cle: 'c', organisationId: 'o', http, signaler: (d) => signales.push(d) }).lire()).toBeNull();
    expect(appels).toHaveLength(10);
    expect(signales).toEqual([{ status: null, raison: 'tronqué' }]);
  });

  it('🔴 le mois change : le cache tombe et le nouveau mois est demandé', async () => {
    let t = Date.parse('2026-10-31T23:00:00.000Z');
    const { http, appels } = faux(() => reponse([ligne('Compute', 'a', 1)]));
    const l = creerLecteurFacture({ cle: 'c', organisationId: 'o', http, maintenant: () => new Date(t) });
    expect((await l.lire())?.periode).toBe('2026-10');
    t = Date.parse('2026-11-01T00:30:00.000Z');
    expect((await l.lire())?.periode).toBe('2026-11');
    expect(appels.map((a) => new URL(a.url).searchParams.get('billing_period'))).toEqual(['2026-10', '2026-11']);
  });

  it('un rafraîchissement en échec garde la dernière bonne valeur du mois, un jour au plus ; deux lectures simultanées n’en font qu’une', async () => {
    let t = LE_29.getTime();
    let panne = false;
    const { http, appels } = faux(() => (panne ? { status: 503, json: null } : reponse([ligne('Compute', 'a', 7)])));
    const l = creerLecteurFacture({ cle: 'c', organisationId: 'o', http, maintenant: () => new Date(t) });
    const [a, b] = await Promise.all([l.lire(), l.lire()]);
    expect(a?.totalHt).toBe(7);
    expect(b).toBe(a);
    expect(appels).toHaveLength(1);
    panne = true;
    t += 3 * 3600_000 + 1;
    expect((await l.lire())?.totalHt).toBe(7);
    t += 22 * 3600_000;
    expect(await l.lire()).toBeNull();
  });

  it('les montants : en texte ou en nombre, un zéro omis ou nul vaut zéro ; un montant illisible ne se dessine pas', async () => {
    const texte = { ...ligne('Compute', 'a', 0), value: { currency_code: 'EUR', units: '12', nanos: null } };
    const { http } = faux(() => reponse([texte]));
    expect((await creerLecteurFacture({ cle: 'c', organisationId: 'o', http }).lire())?.totalHt).toBe(12);
    const illisible = { ...ligne('Compute', 'a', 0), value: { currency_code: 'EUR', units: 'douze' } };
    const { http: h2 } = faux(() => reponse([illisible]));
    expect(await creerLecteurFacture({ cle: 'c', organisationId: 'o', http: h2 }).lire()).toBeNull();
  });

  it('🔴 un refus, un appel jeté, une autre forme ou une autre devise : null, signalé sans la clé', async () => {
    const signales: unknown[] = [];
    for (const r of [{ status: 403, json: {} }, 'jette' as const, { status: 200, json: { autre: 1 } }, reponse([ligne('Compute', 'a', 1, 0, 'USD')])]) {
      const { http } = faux(() => r);
      expect(await creerLecteurFacture({ cle: 'cle-secrete', organisationId: 'o', http, signaler: (d) => signales.push(d) }).lire()).toBeNull();
    }
    expect(signales).toEqual([
      { status: 403, raison: 'refus' }, { status: null, raison: 'appel impossible' }, { status: 200, raison: 'autre forme' }, { status: 200, raison: 'devise' },
    ]);
    expect(JSON.stringify(signales)).not.toContain('cle-secrete');
  });

  it('trois heures de cache pour un succès, cinq minutes pour un échec', async () => {
    let t = LE_29.getTime();
    let panne = true;
    const { http, appels } = faux(() => (panne ? { status: 503, json: null } : reponse([ligne('Compute', 'a', 1)])));
    const l = creerLecteurFacture({ cle: 'c', organisationId: 'o', http, maintenant: () => new Date(t) });
    expect(await l.lire()).toBeNull();
    panne = false;
    t += 4 * 60_000;
    expect(await l.lire()).toBeNull();
    t += 2 * 60_000;
    expect((await l.lire())?.totalHt).toBe(1);
    const avant = appels.length;
    t += 2 * 3600_000;
    await l.lire();
    expect(appels.length).toBe(avant);
    t += 3600_000 + 1;
    await l.lire();
    expect(appels.length).toBe(avant + 1);
  });
});

describe('route /ops/cout', () => {
  const acces = accesOps();
  let OPS = '';
  beforeAll(async () => {
    const s = buildServer({ queue: new FakeQueue(), auth: acces.auth });
    OPS = await acces.jeton(s);
    await s.close();
  });
  const app = (over: Partial<OpsRouteDeps> = {}) => buildServer({
    queue: new FakeQueue(), auth: acces.auth,
    ops: { ...opsInerte, exploitation: { ...exploitationInerte, getTenantOverview: async () => [], getGlobalDaily: async () => [] }, ...over } as OpsRouteDeps,
  });
  const tok = () => ({ headers: { authorization: `Bearer ${OPS}` } });

  it('🔴 sans session d’exploitation : refusé', async () => {
    const s = app();
    expect((await s.inject({ method: 'GET', url: '/ops/cout' })).statusCode).toBe(401);
    await s.close();
  });

  it('sans clé : non configuré ; avec : le coût ; un lecteur qui lève : null, jamais une 500', async () => {
    let s = app();
    expect((await s.inject({ method: 'GET', url: '/ops/cout', ...tok() })).json()).toEqual({ configure: false });
    await s.close();
    const cout = synthetiser([ligne('Compute', 'a', 3)], 0, null, LE_29);
    s = app({ facture: { lire: async () => cout } });
    expect((await s.inject({ method: 'GET', url: '/ops/cout', ...tok() })).json()).toEqual({ configure: true, cout });
    await s.close();
    s = app({ facture: { lire: async () => { throw new Error('facturation'); } } });
    const r = await s.inject({ method: 'GET', url: '/ops/cout', ...tok() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ configure: true, cout: null });
    await s.close();
  });
});
