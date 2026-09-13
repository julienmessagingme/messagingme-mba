import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAide } from '../src/http/aide';
import type { RecapTexte } from '../src/aide/recap-rendu';

/**
 * LA ROUTE DU RÉCAP.
 *
 * 🔴 CE QU'ELLE PROTÈGE, ET RIEN D'AUTRE N'EST TESTÉ ICI. (1) La garde de rôle est CÔTÉ SERVEUR : masquer le
 * bouton n'est pas un contrôle d'accès, et c'est la première fois que le rôle décide de ce qu'on a le droit
 * de LIRE. (2) Le cache : les jetons du bot d'aide sont à NOTRE charge, donc un récap identique pour tout un
 * espace ne doit être calculé qu'UNE fois par jour, y compris quand plusieurs personnes cliquent en même
 * temps. (3) Le jour est choisi par la route, jamais reçu du client.
 */
const recapFait: RecapTexte = { texte: 'Hier : 42 conversations.', redigeParModele: false };

/** Monte la route avec une authentification simulée et une horloge de jour pilotable. */
function app(o: {
  calculer?: (tenantId: string, jour: string, langue: 'fr' | 'en') => Promise<RecapTexte>;
  role?: string;
  tenantId?: string;
  branche?: boolean;
} = {}) {
  let jour = '2026-09-13';
  const calculer = vi.fn(o.calculer ?? (async () => recapFait));
  const server = Fastify();
  const garde = async (req: { auth?: unknown }): Promise<void> => {
    (req as { auth?: unknown }).auth = { tenantId: o.tenantId ?? 't1', userId: 'u1', role: o.role ?? 'admin' };
  };
  registerAide(
    server,
    o.branche === false ? {} : { recap: { calculer, aujourdhui: () => jour } },
    garde as never,
  );
  return Object.assign(server, { calculer, avancerAuLendemain: () => { jour = '2026-09-14'; } });
}

const post = { method: 'POST' as const, url: '/tenants/t1/aide/recap' };

describe('route du récap de la veille', () => {
  it('🔴 un rôle agent reçoit 403, même en appelant la route directement', async () => {
    // Masquer le bouton côté client n'est pas un contrôle d'accès : la garde est ici.
    const r = await app({ role: 'agent' }).inject(post);
    expect(r.statusCode).toBe(403);
  });

  it('admin et manager passent', async () => {
    for (const role of ['admin', 'manager']) {
      const r = await app({ role }).inject(post);
      expect(r.statusCode, role).toBe(200);
      expect(r.json()).toMatchObject({ sait: true, texte: 'Hier : 42 conversations.' });
    }
  });

  /**
   * ⚠️ LES ÉCRANS SONT RÉSOLUS PAR RÔLE, ET HORS DU CACHE. Le tableau qualitatif est `adminOnly` dans la
   * carte : mettre les liens dans ce qu'on met en cache servirait à tout l'espace ceux du premier qui a
   * cliqué, donc donnerait à un manager un lien qu'il n'a pas le droit d'avoir.
   */
  it('⚠️ l admin repart avec un lien, le manager sans', async () => {
    expect((await app({ role: 'admin' }).inject(post)).json().ecrans).toHaveLength(1);
    expect((await app({ role: 'manager' }).inject(post)).json().ecrans).toEqual([]);
  });

  it('🔴 la route demande LA VEILLE, et le jour ne vient jamais du client', async () => {
    const a = app();
    await a.inject({ ...post, payload: { jour: '2020-01-01' } });
    expect(a.calculer.mock.calls[0]).toEqual(['t1', '2026-09-12', 'fr']);
  });

  it('🔴 le deuxième appel du même jour ne recalcule rien', async () => {
    // C'est ce qui divise notre facture par le nombre de personnes de l'espace.
    const a = app();
    await a.inject(post);
    await a.inject(post);
    expect(a.calculer).toHaveBeenCalledTimes(1);
  });

  /**
   * ⚠️ ...MAIS PAS ENTRE DEUX LANGUES. Sans la langue dans la clé, le premier arrivé imposerait la sienne à
   * tout l'espace et un collègue anglophone lirait un récap en français.
   */
  it('⚠️ un collègue anglophone n hérite pas du récap français', async () => {
    const a = app();
    await a.inject({ ...post, payload: { langue: 'fr' } });
    await a.inject({ ...post, payload: { langue: 'en' } });
    expect(a.calculer.mock.calls.map((c) => c[2])).toEqual(['fr', 'en']);
  });

  /**
   * 🔴 ET LES APPELS SIMULTANÉS SE GREFFENT SUR LE MÊME CALCUL. Sans ça, cinq personnes qui cliquent dans la
   * même seconde trouvent toutes le cache vide et lancent toutes un appel de modèle, c'est-à-dire exactement
   * le moment où ça coûte.
   */
  it('🔴 cinq appels SIMULTANÉS ne déclenchent qu un seul calcul', async () => {
    let debloquer: (r: RecapTexte) => void = () => {};
    const enVol = new Promise<RecapTexte>((res) => { debloquer = res; });
    const a = app({ calculer: () => enVol });
    const tous = Promise.all([a.inject(post), a.inject(post), a.inject(post), a.inject(post), a.inject(post)]);
    await new Promise((r) => { setImmediate(r); });
    debloquer(recapFait);
    const reponses = await tous;
    expect(a.calculer).toHaveBeenCalledTimes(1);
    for (const r of reponses) expect(r.statusCode).toBe(200);
  });

  it('⚠️ le cache tourne au changement de jour, sinon on sert le récap d avant-hier indéfiniment', async () => {
    const a = app();
    await a.inject(post);
    a.avancerAuLendemain();
    await a.inject(post);
    expect(a.calculer).toHaveBeenCalledTimes(2);
    expect(a.calculer.mock.calls.map((c) => c[1])).toEqual(['2026-09-12', '2026-09-13']);
  });

  it('🔴 un jeton d un AUTRE espace est refusé', async () => {
    const r = await app({ tenantId: 't2' }).inject(post);
    expect(r.statusCode).toBe(403);
  });

  it('sans récap câblé : 503, jamais un repli muet', async () => {
    const r = await app({ branche: false }).inject(post);
    expect(r.statusCode).toBe(503);
  });

  it('une PANNE rend 502, le corps ne fuit rien, et RIEN n est mis en cache', async () => {
    // Un échec en cache serait resservi à tout l'espace jusqu'au lendemain.
    const a = app({ calculer: async () => { throw new Error('postgres clef=secrete'); } });
    const r = await a.inject(post);
    expect(r.statusCode).toBe(502);
    expect(JSON.stringify(r.json())).not.toContain('secrete');
    await a.inject(post);
    expect(a.calculer).toHaveBeenCalledTimes(2);
  });
});
